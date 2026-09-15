/**
 * Service dependency contracts. `createApp` only talks to these interfaces;
 * `src/adapters/memory/*` implements them in-process (tests, `dev:local`) and
 * `src/adapters/d1/*` + `src/adapters/r2.ts` implement them on Cloudflare.
 */
import type { DropType, JsonValue, LngLat, Rarity } from '@diorama/protocol';
import type { Bbox } from './util/geo.js';

/** Billing plan. */
export type Plan = 'free' | 'pro';
/** Key role: `client` (apps/devices), `server` (app backends), `admin` (app owner console). */
export type Role = 'client' | 'admin' | 'server';
/** Billable unit kinds. */
export type UsageUnit = 'tile' | 'world' | 'search' | 'transit' | 'drops' | 'collect';

// ---------------------------------------------------------------- keys

/** A stored API key. The raw key is never stored, only its SHA-256 hex hash. */
export interface ApiKeyRecord {
  id: string;
  /** Lowercase hex SHA-256 of the raw key. */
  keyHash: string;
  appId: string;
  plan: Plan;
  /** Billable units included per UTC month. */
  monthlyQuota: number;
  role: Role;
  label?: string | null;
  /** Milliseconds since the Unix epoch. */
  createdAt: number;
  revokedAt?: number | null;
}

export interface KeysRepo {
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  insert(record: ApiKeyRecord): Promise<void>;
}

// ---------------------------------------------------------------- usage

/** One unit's usage in a month. */
export interface UsageLine {
  unit: UsageUnit;
  requests: number;
  /** Weighted billable units. */
  units: number;
  /** Units billed beyond the plan quota (paid plans only). */
  overageUnits: number;
}

export interface UsageRecordInput {
  keyId: string;
  /** `YYYY-MM` (UTC). */
  month: string;
  unit: UsageUnit;
  units: number;
  overageUnits: number;
}

export interface UsageRepo {
  /** Total weighted units used by a key in a month. */
  monthTotal(keyId: string, month: string): Promise<number>;
  /** Atomically adds one request of `units` (and `overageUnits`) to the counters. */
  record(input: UsageRecordInput): Promise<void>;
  breakdown(keyId: string, month: string): Promise<UsageLine[]>;
}

// ---------------------------------------------------------------- places

export type PlaceKind = 'poi' | 'address' | 'station';

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  address?: string | null;
  category?: string | null;
  coordinate: LngLat;
  /** Data source tag, e.g. `osm`, `juso`. */
  source?: string | null;
}

export interface PlaceCandidateQuery {
  /** Normalized query (see `normalizeText`). */
  queryNorm: string;
  /** Index tokens of the query (bigrams, or the single character for one-character queries). */
  tokens: string[];
  /** Prefix match on tokens instead of exact token match (one-character queries). */
  prefix: boolean;
  near?: LngLat;
  /** Maximum candidates to return. */
  limit: number;
}

export interface PlacesRepo {
  upsert(places: Place[]): Promise<void>;
  /** Places matching the n-gram/prefix index. Unranked; the app ranks them. */
  searchCandidates(query: PlaceCandidateQuery): Promise<Place[]>;
  /** Nearest place of `kind` within `radiusMeters`. */
  nearest(point: LngLat, radiusMeters: number, kind: PlaceKind): Promise<{ place: Place; distanceMeters: number } | null>;
}

// ---------------------------------------------------------------- transit

export interface TransitStationInput {
  id: string;
  name: string;
  coordinate: LngLat;
}

export interface TransitStation extends TransitStationInput {
  lineIds: string[];
}

export interface TransitLineInput {
  id: string;
  name: string;
  /** CSS hex color, e.g. `#00A84D`. */
  color: string;
  /** Station ids in travel order. */
  stationIds: string[];
}

export interface TransitRepo {
  upsertStations(stations: TransitStationInput[]): Promise<void>;
  upsertLine(line: TransitLineInput): Promise<void>;
  stationsInBbox(bbox: Bbox, limit: number): Promise<TransitStation[]>;
  getLine(lineId: string): Promise<{ id: string; name: string; color: string; stations: TransitStation[] } | null>;
}

// ---------------------------------------------------------------- drops

export type DropArea = { center: LngLat; radiusMeters: number } | { bbox: Bbox };

/** Campaign fields accepted by `POST /v1/drops/campaigns`. */
export interface CampaignSpec {
  channel: string;
  type: DropType;
  rarityWeights: Partial<Record<Rarity, number>>;
  payloadPool: JsonValue[];
  area: DropArea;
  /** Expected drops per km². */
  density: number;
  windowMinutes: number;
  /** ISO 8601. */
  startsAt: string;
  /** ISO 8601. */
  endsAt: string;
  collectRadiusMeters: number;
}

export interface Campaign extends CampaignSpec {
  id: string;
  appId: string;
  /** Secret PRNG seed; never returned by the API, so future drop positions cannot be predicted. */
  seed: string;
  startsAtMs: number;
  endsAtMs: number;
  createdAt: number;
}

export interface CollectFix {
  lng: number;
  lat: number;
  accuracyMeters: number;
  /** Milliseconds since the Unix epoch. */
  timestamp: number;
}

export interface CollectRecord {
  appId: string;
  collectId: string;
  dropId: string;
  userId: string;
  fix: CollectFix;
  /** Server verification time (ms). */
  collectedAt: number;
  receipt: string;
}

export type InsertCollectResult = 'ok' | 'duplicate_collect_id' | 'duplicate_user_drop';

export interface DropsRepo {
  insertCampaign(campaign: Campaign): Promise<void>;
  getCampaign(appId: string, campaignId: string): Promise<Campaign | null>;
  /** Campaigns of an app/channel whose `[startsAt, endsAt)` overlaps `[fromMs, toMs]`. */
  campaignsOverlapping(appId: string, channel: string, fromMs: number, toMs: number): Promise<Campaign[]>;
  findCollect(appId: string, collectId: string): Promise<CollectRecord | null>;
  hasUserCollected(appId: string, userId: string, dropId: string): Promise<boolean>;
  /** The user's most recent verified collect (by `collectedAt`). */
  lastCollect(appId: string, userId: string): Promise<CollectRecord | null>;
  insertCollect(record: CollectRecord): Promise<InsertCollectResult>;
}

// ---------------------------------------------------------------- webhooks

export interface WebhookEndpoint {
  appId: string;
  url: string;
  /** Signing secret (stored in plaintext because the service must sign with it). */
  secret: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryAttempt {
  deliveryId: string;
  attempt: number;
  appId: string;
  eventType: string;
  url: string;
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
  attemptedAt: number;
}

export interface WebhooksRepo {
  upsertEndpoint(endpoint: WebhookEndpoint): Promise<void>;
  getEndpoint(appId: string): Promise<WebhookEndpoint | null>;
  recordAttempt(attempt: DeliveryAttempt): Promise<void>;
  listAttempts(appId: string, deliveryId?: string): Promise<DeliveryAttempt[]>;
}

// ---------------------------------------------------------------- blobs

export interface BlobMeta {
  key: string;
  size: number;
  /** Unquoted entity tag. */
  etag: string;
  contentType?: string | null;
}

/** Object storage (R2 in production). */
export interface BlobStore {
  head(key: string): Promise<BlobMeta | null>;
  get(key: string): Promise<{ meta: BlobMeta; body: ReadableStream<Uint8Array> | ArrayBuffer } | null>;
  /** Reads `[offset, offset + length)`, clamped to the object size. */
  getRange(key: string, offset: number, length: number): Promise<{ meta: BlobMeta; data: ArrayBuffer } | null>;
}

// ---------------------------------------------------------------- runtime

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ServiceOptions {
  /**
   * How tile `Content-Encoding` is produced:
   * - `app` (default): the app gzips with `CompressionStream` when the client accepts gzip (Node, tests).
   * - `runtime`: the app sets `Content-Encoding: gzip` on an uncompressed body and the Workers runtime encodes it.
   */
  tileEncoding?: 'app' | 'runtime';
  /** Delay before webhook attempt 2 and 3, default `[1000, 4000]`. */
  webhookBackoffMs?: number[];
  /** Per-attempt webhook timeout, default 8000. */
  webhookTimeoutMs?: number;
  /**
   * Development only (`dev:local`): also accept webhook URLs on `localhost`,
   * `127.0.0.1` or `[::1]`, over http or https. Default false.
   */
  allowInsecureLocalWebhooks?: boolean;
}

export interface ServiceDeps {
  keys: KeysRepo;
  usage: UsageRepo;
  places: PlacesRepo;
  transit: TransitRepo;
  drops: DropsRepo;
  webhooks: WebhooksRepo;
  blobs: BlobStore;
  clock: Clock;
  /** Web Crypto implementation (`globalThis.crypto`). */
  crypto: typeof globalThis.crypto;
  /** Used for webhook delivery. */
  fetch: typeof fetch;
  secrets: {
    /** Master secret; per-app receipt secrets are derived from it. */
    receiptSecret: string;
  };
  options?: ServiceOptions;
  /** Background task hook. Defaults to `c.executionCtx.waitUntil` when available. */
  waitUntil?: (task: Promise<unknown>) => void;
}
