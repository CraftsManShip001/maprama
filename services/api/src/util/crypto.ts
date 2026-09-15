import { base64UrlEncode, hmacSha256, toHex } from '../verify.js';

const encoder = new TextEncoder();

type WebCrypto = typeof globalThis.crypto;

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(crypto: WebCrypto, text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encoder.encode(text)))));
}

/** Random bytes encoded as base64url. */
export function randomToken(crypto: WebCrypto, bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/** Random lowercase hex string. */
export function randomHex(crypto: WebCrypto, bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/** Raw API key format: `mpr_` + 43 base64url characters (32 random bytes). */
export const API_KEY_PATTERN = /^mpr_[A-Za-z0-9_-]{43}$/;

/** Generates a new raw API key and its SHA-256 hash. Show the raw key once; store only the hash. */
export async function generateApiKey(crypto: WebCrypto): Promise<{ key: string; keyHash: string }> {
  const key = `mpr_${randomToken(crypto, 32)}`;
  return { key, keyHash: await sha256Hex(crypto, key) };
}

/**
 * Per-app receipt secret: `hex(HMAC-SHA256(masterSecret, "maprama-receipt:v1:" + appId))`.
 * Each app gets its own secret, so one app's server cannot forge another app's receipts.
 */
export async function deriveReceiptSecret(masterSecret: string, appId: string): Promise<string> {
  return toHex(await hmacSha256(masterSecret, `maprama-receipt:v1:${appId}`));
}
