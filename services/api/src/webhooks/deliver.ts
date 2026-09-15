import type { JsonValue } from '@diorama/protocol';
import { WEBHOOK_DEFAULTS } from '../config.js';
import type { DeliveryAttempt, ServiceDeps, WebhookEndpoint } from '../deps.js';
import { randomHex } from '../util/crypto.js';
import { WEBHOOK_SIGNATURE_HEADER, signWebhookPayload } from '../verify.js';

export interface WebhookEvent {
  id: string;
  type: 'drop.collected' | 'webhook.test';
  /** Milliseconds since the Unix epoch. */
  createdAt: number;
  appId: string;
  data: { [key: string]: JsonValue };
}

export function newEventId(deps: ServiceDeps): string {
  return `evt_${randomHex(deps.crypto, 12)}`;
}

const LOOPBACK_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Reserved or site-local name suffixes that never belong to a public webhook receiver. */
const PRIVATE_NAME_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'home.arpa'];
const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface WebhookUrlPolicy {
  /** Development only: also allow http(s) to `localhost`, `127.0.0.1` and `[::1]`. */
  allowInsecureLocalWebhooks?: boolean;
}

/**
 * Whether a webhook URL is acceptable (SSRF guard, checked when the endpoint is stored):
 * - `https:` only, without credentials;
 * - no IP-literal hosts (IPv4, or bracketed IPv6). WHATWG URL parsing normalizes
 *   numeric forms such as `2130706433` or `127.1` to dotted IPv4 first, so every
 *   private, link-local and loopback address is rejected as a literal;
 * - no single-label hosts and no `localhost`, `*.local`, `*.internal`,
 *   `*.localdomain` or `*.home.arpa` names.
 *
 * Hostnames that resolve to private addresses through DNS cannot be detected here.
 * On Cloudflare Workers, outbound `fetch` cannot reach private networks.
 */
export function isAllowedWebhookUrl(raw: string, policy: WebhookUrlPolicy = {}): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');

  if (policy.allowInsecureLocalWebhooks && LOOPBACK_DEV_HOSTS.has(host)) return true;
  if (u.protocol !== 'https:') return false;

  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  if (IPV4_LITERAL_RE.test(host)) return false; // IPv4 literal
  if (!host.includes('.')) return false; // single label (localhost, intranet names)
  return !PRIVATE_NAME_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Delivers one event with up to 3 attempts and backoff, recording every attempt.
 * Each attempt is signed with a fresh timestamp:
 * `Diorama-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 */
export async function deliverWebhook(deps: ServiceDeps, endpoint: WebhookEndpoint, event: WebhookEvent): Promise<DeliveryAttempt[]> {
  // Re-check the stored URL: rows saved before the policy existed (or inserted directly) must not be called.
  if (!isAllowedWebhookUrl(endpoint.url, { allowInsecureLocalWebhooks: deps.options?.allowInsecureLocalWebhooks === true })) return [];
  const body = JSON.stringify(event);
  const backoff =deps.options?.webhookBackoffMs ?? WEBHOOK_DEFAULTS.backoffMs;
  const timeoutMs = deps.options?.webhookTimeoutMs ?? WEBHOOK_DEFAULTS.timeoutMs;
  const attempts: DeliveryAttempt[] = [];
  for (let attempt = 1; attempt <= WEBHOOK_DEFAULTS.attempts; attempt++) {
    if (attempt > 1) await deps.clock.sleep(backoff[attempt - 2] ?? backoff[backoff.length - 1] ?? 0);
    const signature = await signWebhookPayload(body, endpoint.secret, deps.clock.now() / 1000);
    let ok = false;
    let responseStatus: number | null = null;
    let error: string | null = null;
    try {
      const res = await deps.fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Diorama-Webhooks/1',
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          'Diorama-Event': event.type,
          'Diorama-Delivery': event.id,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      responseStatus = res.status;
      ok = res.status >= 200 && res.status < 300;
      if (!ok) error = `HTTP ${res.status}`;
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
    } catch (err) {
      error = (err instanceof Error ? `${err.name}: ${err.message}` : 'fetch failed').slice(0, 200);
    }
    const record: DeliveryAttempt = {
      deliveryId: event.id,
      attempt,
      appId: endpoint.appId,
      eventType: event.type,
      url: endpoint.url,
      ok,
      responseStatus,
      error,
      attemptedAt: deps.clock.now(),
    };
    attempts.push(record);
    await deps.webhooks.recordAttempt(record);
    if (ok) break;
  }
  return attempts;
}
