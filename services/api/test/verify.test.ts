import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalJson,
  signReceipt,
  signWebhookPayload,
  verifyReceipt,
  verifyWebhookSignature,
  type ReceiptClaims,
} from '../src/verify.js';

const claims: ReceiptClaims = {
  v: 1,
  appId: 'app1',
  dropId: 'd1.cmpabc.3.wydm9q.7',
  collectId: 'collect-0001',
  userId: 'user-42',
  payload: { track: 'spotify:track:1', coins: 5, tags: ['a', 'b'] },
  collectedAt: 1_789_000_000_000,
  type: 'cd',
  rarity: 'rare',
};

describe('receipts', () => {
  it('round-trips sign → verify', async () => {
    const token = await signReceipt(claims, 'secret-1');
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const res = await verifyReceipt(token, 'secret-1');
    expect(res).toEqual({ ok: true, claims });
  });

  it('is canonical: key order does not change the token', async () => {
    const reordered = JSON.parse(JSON.stringify({ rarity: claims.rarity, type: claims.type, ...claims, payload: { tags: ['a', 'b'], coins: 5, track: 'spotify:track:1' } }));
    expect(await signReceipt(reordered, 's')).toBe(await signReceipt(claims, 's'));
    expect(canonicalJson({ b: 1, a: [{ d: null, c: true }] })).toBe('{"a":[{"c":true,"d":null}],"b":1}');
  });

  it('rejects tampered tokens, wrong secrets and garbage', async () => {
    const token = await signReceipt(claims, 'secret-1');
    const [body, mac] = token.split('.') as [string, string];
    const forged = new TextEncoder().encode(new TextDecoder().decode(base64UrlDecode(body)!).replace('user-42', 'user-43'));
    expect(await verifyReceipt(`${base64UrlEncode(forged)}.${mac}`, 'secret-1')).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyReceipt(token, 'secret-2')).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyReceipt('nope', 'secret-1')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyReceipt('a.b.c', 'secret-1')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyReceipt('###.###', 'secret-1')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'drop.collected', data: { userId: 'u' } });
  const t = 1_789_000_000;

  it('accepts a valid signature within tolerance', async () => {
    const header = await signWebhookPayload(body, 'whsec_x', t);
    expect(header).toMatch(/^t=1789000000,v1=[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature(body, header, 'whsec_x', 300, t + 299)).toEqual({ ok: true, timestamp: t });
    const rotated = `${header.replace(/v1=[0-9a-f]+/, `v1=${'0'.repeat(64)}`)},${header.split(',')[1]}`;
    expect((await verifyWebhookSignature(body, rotated, 'whsec_x', 300, t)).ok).toBe(true);
  });

  it('rejects tampered bodies, wrong secrets and tampered timestamps', async () => {
    const header = await signWebhookPayload(body, 'whsec_x', t);
    expect(await verifyWebhookSignature(body.replace('"u"', '"v"'), header, 'whsec_x', 300, t)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyWebhookSignature(body, header, 'whsec_y', 300, t)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyWebhookSignature(body, header.replace(`t=${t}`, `t=${t + 1}`), 'whsec_x', 300, t)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects expired and malformed headers', async () => {
    const header = await signWebhookPayload(body, 'whsec_x', t);
    expect(await verifyWebhookSignature(body, header, 'whsec_x', 300, t + 301)).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyWebhookSignature(body, header, 'whsec_x', 300, t - 301)).toEqual({ ok: false, reason: 'expired' });
    expect(await verifyWebhookSignature(body, null, 'whsec_x')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyWebhookSignature(body, 't=abc,v1=zz', 'whsec_x')).toEqual({ ok: false, reason: 'malformed' });
    // Default clock: a fresh signature verifies.
    expect((await verifyWebhookSignature(body, await signWebhookPayload(body, 'k', Date.now() / 1000), 'k')).ok).toBe(true);
  });

  it('is a pure module with no imports', () => {
    const src = readFileSync(new URL('../src/verify.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
