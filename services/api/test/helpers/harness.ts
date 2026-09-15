import type { DropSpec, LngLat } from '@diorama/protocol';
import { expect } from 'vitest';
import { ManualClock, createMemoryDeps, type MemoryServiceDeps } from '../../src/adapters/memory/index.js';
import { createApp } from '../../src/app.js';
import type { Plan, Role, ServiceDeps, ServiceOptions } from '../../src/deps.js';
import { generateApiKey } from '../../src/util/crypto.js';

export const T0 = Date.parse('2026-09-15T12:00:00Z');
export const SEONGSU: LngLat = { lng: 127.0559, lat: 37.5446 };
export const GANGNAM: LngLat = { lng: 127.0276, lat: 37.4979 };
export const RECEIPT_SECRET = 'test-receipt-master-secret-0123456789abcdef';

/** Moves a point north by `meters`. */
export const north = (p: LngLat, meters: number): LngLat => ({ lng: p.lng, lat: p.lat + meters / 111_195 });

export interface FetchCall {
  url: string;
  init: RequestInit;
  body: string;
  headers: Headers;
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  deps: MemoryServiceDeps;
  appDeps: ServiceDeps;
  clock: ManualClock;
  fetchCalls: FetchCall[];
  fetchResponses: (() => Response | Promise<Response>)[];
  addKey(opts?: { role?: Role; plan?: Plan; quota?: number; appId?: string; revoked?: boolean }): Promise<string>;
  request(path: string, opts?: { key?: string; method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  flush(): Promise<void>;
}

export function createHarness(opts: { options?: ServiceOptions; override?: Partial<ServiceDeps> } = {}): Harness {
  const clock = new ManualClock(T0);
  const pending: Promise<unknown>[] = [];
  const fetchCalls: FetchCall[] = [];
  const fetchResponses: (() => Response | Promise<Response>)[] = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init, body: String(init.body ?? ''), headers: new Headers(init.headers) });
    const next = fetchResponses.shift();
    return next ? next() : new Response('ok', { status: 200 });
  };
  const deps = createMemoryDeps({
    clock,
    fetch: fakeFetch,
    receiptSecret: RECEIPT_SECRET,
    ...(opts.options ? { options: opts.options } : {}),
    waitUntil: (p) => pending.push(p),
  });
  const appDeps: ServiceDeps = { ...deps, ...opts.override };
  const app = createApp(appDeps);
  let n = 0;
  return {
    app,
    deps,
    appDeps,
    clock,
    fetchCalls,
    fetchResponses,
    async addKey({ role = 'client', plan = 'free', quota = 1_000_000, appId = 'app1', revoked = false } = {}) {
      const { key, keyHash } = await generateApiKey(globalThis.crypto);
      await appDeps.keys.insert({ id: `key${++n}`, keyHash, appId, plan, monthlyQuota: quota, role, createdAt: T0, revokedAt: revoked ? T0 : null });
      return key;
    },
    async request(path, { key, method = 'GET', body, headers = {} } = {}) {
      const h: Record<string, string> = { ...headers };
      if (key) h.authorization = `Bearer ${key}`;
      if (body !== undefined) h['content-type'] = 'application/json';
      return app.request(path, { method, headers: h, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    },
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

export function campaignBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'main',
    type: 'coin',
    rarityWeights: { common: 8, rare: 2 },
    payloadPool: [{ coins: 1 }, { coins: 5 }],
    area: { center: SEONGSU, radiusMeters: 800 },
    density: 40,
    windowMinutes: 10,
    startsAt: new Date(T0 - 3_600_000).toISOString(),
    endsAt: new Date(T0 + 86_400_000).toISOString(),
    collectRadiusMeters: 20,
    ...overrides,
  };
}

export async function createCampaign(h: Harness, key: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await h.request('/v1/drops/campaigns', { key, method: 'POST', body: campaignBody(overrides) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { campaign: { id: string } }).campaign;
}

export async function nearby(h: Harness, key: string, p: LngLat, radius = 500, channel = 'main'): Promise<DropSpec[]> {
  const res = await h.request(`/v1/drops/nearby?lng=${p.lng}&lat=${p.lat}&radius=${radius}&channel=${channel}`, { key });
  expect(res.status).toBe(200);
  return ((await res.json()) as { drops: DropSpec[] }).drops;
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
