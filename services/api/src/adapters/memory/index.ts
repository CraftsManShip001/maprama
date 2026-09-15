/**
 * In-memory implementations of every service dependency, for tests and
 * `npm run dev:local`. Not durable; not for production.
 */
import { haversineMeters, type LngLat } from '@maprama/protocol';
import type {
  ApiKeyRecord,
  BlobMeta,
  BlobStore,
  Campaign,
  Clock,
  CollectRecord,
  DeliveryAttempt,
  DropsRepo,
  InsertCollectResult,
  KeysRepo,
  Place,
  PlaceCandidateQuery,
  PlaceKind,
  PlacesRepo,
  ServiceDeps,
  ServiceOptions,
  TransitLineInput,
  TransitRepo,
  TransitStation,
  TransitStationInput,
  UsageLine,
  UsageRecordInput,
  UsageRepo,
  UsageUnit,
  WebhookEndpoint,
  WebhooksRepo,
} from '../../deps.js';
import { indexTokens } from '../../search/normalize.js';
import { bboxContains, type Bbox } from '../../util/geo.js';
import { toHex } from '../../verify.js';

export class MemoryKeysRepo implements KeysRepo {
  readonly records = new Map<string, ApiKeyRecord>();
  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    return this.records.get(keyHash) ?? null;
  }
  async insert(record: ApiKeyRecord): Promise<void> {
    if (this.records.has(record.keyHash)) throw new Error('duplicate key hash');
    this.records.set(record.keyHash, { ...record });
  }
}

export class MemoryUsageRepo implements UsageRepo {
  private readonly counters = new Map<string, Map<UsageUnit, UsageLine>>();
  async monthTotal(keyId: string, month: string): Promise<number> {
    let total = 0;
    for (const l of this.counters.get(`${keyId}|${month}`)?.values() ?? []) total += l.units;
    return total;
  }
  async record(input: UsageRecordInput): Promise<void> {
    const k = `${input.keyId}|${input.month}`;
    let units = this.counters.get(k);
    if (!units) this.counters.set(k, (units = new Map()));
    const line = units.get(input.unit) ?? { unit: input.unit, requests: 0, units: 0, overageUnits: 0 };
    line.requests += 1;
    line.units += input.units;
    line.overageUnits += input.overageUnits;
    units.set(input.unit, line);
  }
  async breakdown(keyId: string, month: string): Promise<UsageLine[]> {
    return [...(this.counters.get(`${keyId}|${month}`)?.values() ?? [])].map((l) => ({ ...l }));
  }
}

export class MemoryPlacesRepo implements PlacesRepo {
  private readonly places = new Map<string, Place>();
  private readonly tokensById = new Map<string, string[]>();
  private readonly index = new Map<string, Set<string>>();

  async upsert(places: Place[]): Promise<void> {
    for (const p of places) {
      for (const t of this.tokensById.get(p.id) ?? []) this.index.get(t)?.delete(p.id);
      const tokens = indexTokens(p.name, p.address);
      this.tokensById.set(p.id, tokens);
      for (const t of tokens) {
        let set = this.index.get(t);
        if (!set) this.index.set(t, (set = new Set()));
        set.add(p.id);
      }
      this.places.set(p.id, { ...p, coordinate: { ...p.coordinate } });
    }
  }

  async searchCandidates(q: PlaceCandidateQuery): Promise<Place[]> {
    const hits = new Map<string, number>();
    for (const token of q.tokens) {
      const ids = new Set<string>();
      if (q.prefix) {
        for (const [t, set] of this.index) if (t.startsWith(token)) for (const id of set) ids.add(id);
      } else {
        for (const id of this.index.get(token) ?? []) ids.add(id);
      }
      for (const id of ids) hits.set(id, (hits.get(id) ?? 0) + 1);
    }
    const rows = [...hits].map(([id, count]) => ({ place: this.places.get(id)!, count }));
    const near = q.near;
    rows.sort(
      (a, b) =>
        b.count - a.count ||
        (near ? haversineMeters(near, a.place.coordinate) - haversineMeters(near, b.place.coordinate) : 0) ||
        (a.place.id < b.place.id ? -1 : 1),
    );
    return rows.slice(0, q.limit).map((r) => r.place);
  }

  async nearest(point: LngLat, radiusMeters: number, kind: PlaceKind): Promise<{ place: Place; distanceMeters: number } | null> {
    let best: { place: Place; distanceMeters: number } | null = null;
    for (const p of this.places.values()) {
      if (p.kind !== kind) continue;
      const d = haversineMeters(point, p.coordinate);
      if (d <= radiusMeters && (!best || d < best.distanceMeters)) best = { place: p, distanceMeters: d };
    }
    return best;
  }
}

export class MemoryTransitRepo implements TransitRepo {
  private readonly stations = new Map<string, TransitStationInput>();
  private readonly lines = new Map<string, TransitLineInput>();

  async upsertStations(stations: TransitStationInput[]): Promise<void> {
    for (const s of stations) this.stations.set(s.id, { ...s, coordinate: { ...s.coordinate } });
  }
  async upsertLine(line: TransitLineInput): Promise<void> {
    for (const id of line.stationIds) if (!this.stations.has(id)) throw new Error(`unknown station ${id}`);
    this.lines.set(line.id, { ...line, stationIds: [...line.stationIds] });
  }
  private withLines(s: TransitStationInput): TransitStation {
    const lineIds = [...this.lines.values()].filter((l) => l.stationIds.includes(s.id)).map((l) => l.id).sort();
    return { ...s, lineIds };
  }
  async stationsInBbox(bbox: Bbox, limit: number): Promise<TransitStation[]> {
    return [...this.stations.values()]
      .filter((s) => bboxContains(bbox, s.coordinate))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((s) => this.withLines(s));
  }
  async getLine(lineId: string): Promise<{ id: string; name: string; color: string; stations: TransitStation[] } | null> {
    const line = this.lines.get(lineId);
    if (!line) return null;
    return { id: line.id, name: line.name, color: line.color, stations: line.stationIds.map((id) => this.withLines(this.stations.get(id)!)) };
  }
}

export class MemoryDropsRepo implements DropsRepo {
  readonly campaigns = new Map<string, Campaign>();
  readonly collects = new Map<string, CollectRecord>();
  private readonly userDrops = new Set<string>();

  async insertCampaign(c: Campaign): Promise<void> {
    this.campaigns.set(c.id, structuredClone(c));
  }
  async getCampaign(appId: string, campaignId: string): Promise<Campaign | null> {
    const c = this.campaigns.get(campaignId);
    return c && c.appId === appId ? structuredClone(c) : null;
  }
  async campaignsOverlapping(appId: string, channel: string, fromMs: number, toMs: number): Promise<Campaign[]> {
    return [...this.campaigns.values()]
      .filter((c) => c.appId === appId && c.channel === channel && c.endsAtMs > fromMs && c.startsAtMs <= toMs)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => structuredClone(c));
  }
  async findCollect(appId: string, collectId: string): Promise<CollectRecord | null> {
    const r = this.collects.get(`${appId}|${collectId}`);
    return r ? structuredClone(r) : null;
  }
  async hasUserCollected(appId: string, userId: string, dropId: string): Promise<boolean> {
    return this.userDrops.has(`${appId}|${userId}|${dropId}`);
  }
  async lastCollect(appId: string, userId: string): Promise<CollectRecord | null> {
    let best: CollectRecord | null = null;
    for (const r of this.collects.values()) {
      if (r.appId === appId && r.userId === userId && (!best || r.collectedAt >= best.collectedAt)) best = r;
    }
    return best ? structuredClone(best) : null;
  }
  async insertCollect(r: CollectRecord): Promise<InsertCollectResult> {
    const k = `${r.appId}|${r.collectId}`;
    if (this.collects.has(k)) return 'duplicate_collect_id';
    const u = `${r.appId}|${r.userId}|${r.dropId}`;
    if (this.userDrops.has(u)) return 'duplicate_user_drop';
    this.collects.set(k, structuredClone(r));
    this.userDrops.add(u);
    return 'ok';
  }
}

export class MemoryWebhooksRepo implements WebhooksRepo {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  readonly attempts: DeliveryAttempt[] = [];
  async upsertEndpoint(e: WebhookEndpoint): Promise<void> {
    // Same semantics as the D1 upsert: createdAt of an existing endpoint is kept.
    const existing = this.endpoints.get(e.appId);
    this.endpoints.set(e.appId, { ...e, createdAt: existing?.createdAt ?? e.createdAt });
  }
  async getEndpoint(appId: string): Promise<WebhookEndpoint | null> {
    const e = this.endpoints.get(appId);
    return e ? { ...e } : null;
  }
  async recordAttempt(a: DeliveryAttempt): Promise<void> {
    this.attempts.push({ ...a });
  }
  async listAttempts(appId: string, deliveryId?: string): Promise<DeliveryAttempt[]> {
    return this.attempts.filter((a) => a.appId === appId && (!deliveryId || a.deliveryId === deliveryId)).map((a) => ({ ...a }));
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, { data: Uint8Array<ArrayBuffer>; etag: string; contentType: string | null }>();
  /** Every range read, for tests. */
  readonly rangeReads: { key: string; offset: number; length: number }[] = [];

  async put(key: string, data: Uint8Array | ArrayBuffer | string, contentType: string | null = null): Promise<BlobMeta> {
    const bytes =
      typeof data === 'string' ? new Uint8Array(new TextEncoder().encode(data)) : data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data);
    const etag = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 32);
    this.objects.set(key, { data: bytes, etag, contentType });
    return { key, size: bytes.byteLength, etag, contentType };
  }

  async head(key: string): Promise<BlobMeta | null> {
    const o = this.objects.get(key);
    return o ? { key, size: o.data.byteLength, etag: o.etag, contentType: o.contentType } : null;
  }

  async get(key: string): Promise<{ meta: BlobMeta; body: ArrayBuffer } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { meta: { key, size: o.data.byteLength, etag: o.etag, contentType: o.contentType }, body: o.data.slice().buffer };
  }

  async getRange(key: string, offset: number, length: number): Promise<{ meta: BlobMeta; data: ArrayBuffer } | null> {
    this.rangeReads.push({ key, offset, length });
    const o = this.objects.get(key);
    if (!o) return null;
    const start = Math.min(Math.max(0, offset), o.data.byteLength);
    const end = Math.min(o.data.byteLength, start + Math.max(0, length));
    return { meta: { key, size: o.data.byteLength, etag: o.etag, contentType: o.contentType }, data: o.data.slice(start, end).buffer };
  }
}

/** A controllable clock: `sleep` advances time instantly and records the delay. */
export class ManualClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(private t: number = Date.parse('2026-09-15T12:00:00Z')) {}
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface MemoryServiceDeps extends ServiceDeps {
  keys: MemoryKeysRepo;
  usage: MemoryUsageRepo;
  places: MemoryPlacesRepo;
  transit: MemoryTransitRepo;
  drops: MemoryDropsRepo;
  webhooks: MemoryWebhooksRepo;
  blobs: MemoryBlobStore;
}

export interface MemoryDepsOptions {
  clock?: Clock;
  fetch?: typeof fetch;
  receiptSecret?: string;
  options?: ServiceOptions;
  waitUntil?: (task: Promise<unknown>) => void;
}

export function createMemoryDeps(opts: MemoryDepsOptions = {}): MemoryServiceDeps {
  return {
    keys: new MemoryKeysRepo(),
    usage: new MemoryUsageRepo(),
    places: new MemoryPlacesRepo(),
    transit: new MemoryTransitRepo(),
    drops: new MemoryDropsRepo(),
    webhooks: new MemoryWebhooksRepo(),
    blobs: new MemoryBlobStore(),
    clock: opts.clock ?? systemClock,
    crypto: globalThis.crypto,
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    secrets: { receiptSecret: opts.receiptSecret ?? 'local-dev-receipt-secret-change-me-0000000000' },
    ...(opts.options ? { options: opts.options } : {}),
    ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
  };
}
