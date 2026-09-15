/**
 * `@diorama/api/verify`: helpers for app servers that receive data from the
 * Diorama service.
 *
 * - {@link verifyWebhookSignature}: checks the `Diorama-Signature` header of a
 *   webhook request against the raw request body.
 * - {@link verifyReceipt}: checks a drop-collection receipt token returned by
 *   `POST /v1/drops/collect` (or carried inside a `drop.collected` webhook).
 *
 * Pure and runtime-agnostic: only Web Crypto (`globalThis.crypto.subtle`),
 * `TextEncoder` and `TextDecoder` are used, so the module runs unchanged on
 * Node.js 20+, Deno, Bun, Cloudflare Workers and browsers.
 *
 * ```ts
 * import { verifyWebhookSignature, verifyReceipt } from '@diorama/api/verify';
 *
 * const raw = await request.text(); // the exact bytes, before JSON.parse
 * const sig = await verifyWebhookSignature(raw, request.headers.get('Diorama-Signature'), process.env.DIORAMA_WEBHOOK_SECRET!);
 * if (!sig.ok) return new Response('bad signature', { status: 400 });
 * const event = JSON.parse(raw);
 * const receipt = await verifyReceipt(event.data.receipt, process.env.DIORAMA_RECEIPT_SECRET!);
 * if (receipt.ok) grantReward(receipt.claims.userId, receipt.claims.payload);
 * ```
 *
 * @packageDocumentation
 */

/** JSON value (structurally identical to `JsonValue` in `@diorama/protocol`; kept local so this module has zero imports). */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Name of the HTTP header carrying the webhook signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'Diorama-Signature';

/** Current receipt token format version. */
export const RECEIPT_VERSION = 1;

/** Claims carried by a drop-collection receipt. */
export interface ReceiptClaims {
  /** Token format version (currently `1`). */
  v: number;
  /** App that owns the campaign. */
  appId: string;
  /** Collected drop id. */
  dropId: string;
  /** Client-generated collection nonce. */
  collectId: string;
  /** App-defined user id the collection was verified for. */
  userId: string;
  /** Payload attached to the drop (from the campaign payload pool). */
  payload: Json;
  /** Server verification time, milliseconds since the Unix epoch. */
  collectedAt: number;
  /** Drop visual type. */
  type?: string;
  /** Drop rarity. */
  rarity?: string;
  /** Drop value (e.g. coin amount). */
  value?: number;
}

/** Result of {@link verifyWebhookSignature}. */
export type WebhookVerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

/** Result of {@link verifyReceipt}. */
export type ReceiptVerifyResult = { ok: true; claims: ReceiptClaims } | { ok: false; reason: 'malformed' | 'mismatch' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serializes a JSON value with object keys sorted recursively (the canonical form that receipts sign). */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`).join(',')}}`;
}

/** Encodes bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes unpadded base64url; returns `null` for invalid input. */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Lowercase hex encoding. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

/** Constant-time comparison of two byte arrays (length difference is not hidden, contents are). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i % (a.length || 1)] ?? 0) ^ (b[i % (b.length || 1)] ?? 0);
  return diff === 0 && a.length === b.length;
}

/** Constant-time comparison of two strings. */
export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}

/** HMAC-SHA256 of `message` keyed with `secret`. */
export async function hmacSha256(secret: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = new Uint8Array(typeof secret === 'string' ? encoder.encode(secret) : secret);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new Uint8Array(typeof message === 'string' ? encoder.encode(message) : message);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/**
 * Computes the `Diorama-Signature` header value for `rawBody` at unix time `timestampSec`:
 * `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`.
 */
export async function signWebhookPayload(rawBody: string, secret: string, timestampSec: number): Promise<string> {
  const t = Math.floor(timestampSec);
  const mac = await hmacSha256(secret, `${t}.${rawBody}`);
  return `t=${t},v1=${toHex(mac)}`;
}

/**
 * Verifies a webhook `Diorama-Signature` header.
 *
 * @param rawBody The exact request body string as received (do not re-serialize parsed JSON).
 * @param header The `Diorama-Signature` header value (`t=<unix>,v1=<hex>`; several `v1` entries are allowed during secret rotation).
 * @param secret The endpoint secret returned by `POST /v1/webhooks`.
 * @param toleranceSec Maximum age (and clock skew) of the timestamp, default 300 seconds.
 * @param nowSec Current unix time in seconds; defaults to `Date.now() / 1000`.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec: number = Date.now() / 1000,
): Promise<WebhookVerifyResult> {
  if (typeof header !== 'string' || header.length === 0 || typeof rawBody !== 'string') return { ok: false, reason: 'malformed' };
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === undefined || signatures.length === 0) return { ok: false, reason: 'malformed' };
  const expected = toHex(await hmacSha256(secret, `${timestamp}.${rawBody}`));
  let matched = false;
  for (const sig of signatures) if (timingSafeEqualString(sig, expected)) matched = true;
  if (!matched) return { ok: false, reason: 'mismatch' };
  if (Math.abs(nowSec - timestamp) > toleranceSec) return { ok: false, reason: 'expired' };
  return { ok: true, timestamp };
}

/**
 * Signs receipt claims: `base64url(canonicalJson(claims)) + "." + base64url(HMAC-SHA256(secret, canonicalJson(claims)))`.
 * Used by the service; exported so tests and tooling can mint tokens.
 */
export async function signReceipt(claims: ReceiptClaims, secret: string): Promise<string> {
  const json = canonicalJson(claims as unknown as Json);
  const bytes = encoder.encode(json);
  const mac = await hmacSha256(secret, bytes);
  return `${base64UrlEncode(bytes)}.${base64UrlEncode(mac)}`;
}

/**
 * Verifies a receipt token and returns its claims.
 *
 * @param token The `receipt` string from `POST /v1/drops/collect` or a `drop.collected` webhook.
 * @param secret The app's receipt secret (returned by `POST /v1/webhooks` as `receiptSecret`).
 */
export async function verifyReceipt(token: string, secret: string): Promise<ReceiptVerifyResult> {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const body = base64UrlDecode(parts[0]!);
  const mac = base64UrlDecode(parts[1]!);
  if (!body || !mac || body.length === 0) return { ok: false, reason: 'malformed' };
  const expected = await hmacSha256(secret, body);
  if (!timingSafeEqualBytes(mac, expected)) return { ok: false, reason: 'mismatch' };
  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(body));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isReceiptClaims(claims)) return { ok: false, reason: 'malformed' };
  return { ok: true, claims };
}

function isReceiptClaims(v: unknown): v is ReceiptClaims {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.v === 'number' &&
    typeof o.appId === 'string' &&
    typeof o.dropId === 'string' &&
    typeof o.collectId === 'string' &&
    typeof o.userId === 'string' &&
    typeof o.collectedAt === 'number' &&
    'payload' in o
  );
}
