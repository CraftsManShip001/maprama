import { describe, expect, it } from 'vitest';
import { UNIT_WEIGHTS } from '../src/config.js';
import { createHarness, json } from './helpers/harness.js';

type UsageJson = {
  month: string;
  plan: string;
  monthlyQuota: number;
  usedUnits: number;
  remainingUnits: number;
  overageUnits: number;
  breakdown: { unit: string; requests: number; units: number; overageUnits: number; weight: number }[];
};

describe('usage metering', () => {
  it('free plan: returns 429 QUOTA_EXCEEDED past quota, with usage headers', async () => {
    const h = createHarness();
    expect(UNIT_WEIGHTS.search).toBe(5);
    const key = await h.addKey({ plan: 'free', quota: 12 });

    const r1 = await h.request('/v1/search?q=a', { key });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Maprama-Usage')).toBe('5/12');
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('7');
    expect((await h.request('/v1/search?q=a', { key })).status).toBe(200);

    const r3 = await h.request('/v1/search?q=a', { key });
    expect(r3.status).toBe(429);
    expect((await json<{ error: { code: string } }>(r3)).error.code).toBe('QUOTA_EXCEEDED');
    expect(r3.headers.get('X-Maprama-Usage')).toBe('10/12');
    expect(r3.headers.get('X-RateLimit-Remaining')).toBe('2');

    const usage = await json<UsageJson>(await h.request('/v1/usage', { key }));
    expect(usage.usedUnits).toBe(10);
    expect(usage.overageUnits).toBe(0);
    expect(usage.breakdown.find((b) => b.unit === 'search')).toMatchObject({ requests: 2, units: 10 });
  });

  it('pro plan: continues past quota and records overage', async () => {
    const h = createHarness();
    const key = await h.addKey({ plan: 'pro', quota: 12 });
    for (let i = 0; i < 4; i++) expect((await h.request('/v1/search?q=a', { key })).status).toBe(200);
    const usage = await json<UsageJson>(await h.request('/v1/usage', { key }));
    expect(usage.plan).toBe('pro');
    expect(usage.usedUnits).toBe(20);
    expect(usage.remainingUnits).toBe(0);
    // 3rd request crosses 12 by 3 units, 4th is fully overage (5).
    expect(usage.overageUnits).toBe(8);
    expect(usage.breakdown.find((b) => b.unit === 'search')).toMatchObject({ requests: 4, units: 20, overageUnits: 8, weight: 5 });
  });

  it('does not bill invalid requests and resets on the next UTC month', async () => {
    const h = createHarness();
    const key = await h.addKey({ plan: 'free', quota: 100 });
    expect((await h.request('/v1/search', { key })).status).toBe(400);
    expect((await json<UsageJson>(await h.request('/v1/usage', { key }))).usedUnits).toBe(0);
    expect((await h.request('/v1/search?q=a', { key })).status).toBe(200);
    const before = await json<UsageJson>(await h.request('/v1/usage', { key }));
    expect(before.month).toBe('2026-09');
    expect(before.usedUnits).toBe(5);
    h.clock.set(Date.parse('2026-10-01T00:00:00Z'));
    const after = await json<UsageJson>(await h.request('/v1/usage', { key }));
    expect(after.month).toBe('2026-10');
    expect(after.usedUnits).toBe(0);
  });

  it('isolates usage per key', async () => {
    const h = createHarness();
    const a = await h.addKey({ quota: 5 });
    const b = await h.addKey({ quota: 5 });
    expect((await h.request('/v1/search?q=a', { key: a })).status).toBe(200);
    expect((await h.request('/v1/search?q=a', { key: a })).status).toBe(429);
    expect((await h.request('/v1/search?q=a', { key: b })).status).toBe(200);
  });
});
