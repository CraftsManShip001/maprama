import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/index';
import { haversineMeters, type LngLat } from '@maprama/protocol';
import type {
  ApiKeyRecord,
  Campaign,
  CampaignSpec,
  CollectRecord,
  DeliveryAttempt,
  DropsRepo,
  InsertCollectResult,
  KeysRepo,
  Place,
  PlaceCandidateQuery,
  PlaceKind,
  PlacesRepo,
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
import { circleBbox, type Bbox } from '../../util/geo.js';
import { apiKeyInsert, lineUpsert, placeUpsert, stationUpsert, type Stmt } from './statements.js';

const bind = (db: D1Database, s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params);

async function batchChunks(db: D1Database, stmts: Stmt[], size = 90): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size).map((s) => bind(db, s)));
  }
}

// ---------------------------------------------------------------- keys

interface KeyRow {
  id: string;
  key_hash: string;
  app_id: string;
  plan: string;
  monthly_quota: number;
  role: string;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
}

export class D1KeysRepo implements KeysRepo {
  constructor(private readonly db: D1Database) {}

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const r = await this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(keyHash).first<KeyRow>();
    if (!r) return null;
    return {
      id: r.id,
      keyHash: r.key_hash,
      appId: r.app_id,
      plan: r.plan as ApiKeyRecord['plan'],
      monthlyQuota: Number(r.monthly_quota),
      role: r.role as ApiKeyRecord['role'],
      label: r.label,
      createdAt: Number(r.created_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    };
  }

  async insert(record: ApiKeyRecord): Promise<void> {
    await bind(this.db, apiKeyInsert(record)).run();
  }
}

// ---------------------------------------------------------------- usage

export class D1UsageRepo implements UsageRepo {
  constructor(private readonly db: D1Database) {}

  async monthTotal(keyId: string, month: string): Promise<number> {
    const r = await this.db
      .prepare('SELECT COALESCE(SUM(units), 0) AS total FROM usage_counters WHERE key_id = ? AND month = ?')
      .bind(keyId, month)
      .first<{ total: number }>();
    return Number(r?.total ?? 0);
  }

  async record(input: UsageRecordInput): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO usage_counters (key_id, month, unit, requests, units, overage_units) VALUES (?, ?, ?, 1, ?, ?) ' +
          'ON CONFLICT (key_id, month, unit) DO UPDATE SET requests = requests + 1, units = units + excluded.units, overage_units = overage_units + excluded.overage_units',
      )
      .bind(input.keyId, input.month, input.unit, input.units, input.overageUnits)
      .run();
  }

  async breakdown(keyId: string, month: string): Promise<UsageLine[]> {
    const { results } = await this.db
      .prepare('SELECT unit, requests, units, overage_units FROM usage_counters WHERE key_id = ? AND month = ? ORDER BY unit')
      .bind(keyId, month)
      .all<{ unit: string; requests: number; units: number; overage_units: number }>();
    return results.map((r) => ({
      unit: r.unit as UsageUnit,
      requests: Number(r.requests),
      units: Number(r.units),
      overageUnits: Number(r.overage_units),
    }));
  }
}

// ---------------------------------------------------------------- places

interface PlaceRow {
  id: string;
  kind: string;
  name: string;
  address: string | null;
  category: string | null;
  lng: number;
  lat: number;
  source: string | null;
}

const placeFromRow = (r: PlaceRow): Place => ({
  id: r.id,
  kind: r.kind as PlaceKind,
  name: r.name,
  address: r.address,
  category: r.category,
  coordinate: { lng: Number(r.lng), lat: Number(r.lat) },
  source: r.source,
});

/** FTS5 MATCH expression from index tokens (each quoted; `*` for prefix). */
export function ftsMatchExpression(tokens: string[], prefix: boolean): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"${prefix ? '*' : ''}`).join(' OR ');
}

export class D1PlacesRepo implements PlacesRepo {
  constructor(private readonly db: D1Database) {}

  async upsert(places: Place[]): Promise<void> {
    await batchChunks(this.db, places.flatMap(placeUpsert));
  }

  async searchCandidates(q: PlaceCandidateQuery): Promise<Place[]> {
    if (q.tokens.length === 0) return [];
    const match = ftsMatchExpression(q.tokens, q.prefix);
    const cols = 'p.id, p.kind, p.name, p.address, p.category, p.lng, p.lat, p.source';
    const out = new Map<string, Place>();
    if (q.near) {
      // Local pass first (~20 km, nearest matches by approximate planar distance) for up to half
      // of the candidates, so common names near the user are not crowded out nationally.
      const [w, s, e, n] = circleBbox(q.near, 20_000);
      const cosLat = Math.cos((q.near.lat * Math.PI) / 180);
      const { results } = await this.db
        .prepare(
          `SELECT ${cols} FROM places_fts JOIN places p ON p.pk = places_fts.rowid ` +
            'WHERE places_fts MATCH ? AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ? ' +
            'ORDER BY (p.lat - ?) * (p.lat - ?) + (p.lng - ?) * (p.lng - ?) * ? LIMIT ?',
        )
        .bind(match, s, n, w, e, q.near.lat, q.near.lat, q.near.lng, q.near.lng, cosLat * cosLat, Math.ceil(q.limit / 2))
        .all<PlaceRow>();
      for (const r of results) out.set(r.id, placeFromRow(r));
    }
    if (out.size < q.limit) {
      const { results } = await this.db
        .prepare(`SELECT ${cols} FROM places_fts JOIN places p ON p.pk = places_fts.rowid WHERE places_fts MATCH ? ORDER BY bm25(places_fts) LIMIT ?`)
        .bind(match, q.limit)
        .all<PlaceRow>();
      for (const r of results) if (!out.has(r.id)) out.set(r.id, placeFromRow(r));
    }
    return [...out.values()].slice(0, q.limit);
  }

  async nearest(point: LngLat, radiusMeters: number, kind: PlaceKind): Promise<{ place: Place; distanceMeters: number } | null> {
    const [w, s, e, n] = circleBbox(point, radiusMeters);
    const { results } = await this.db
      .prepare(
        'SELECT id, kind, name, address, category, lng, lat, source FROM places WHERE kind = ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 2000',
      )
      .bind(kind, s, n, w, e)
      .all<PlaceRow>();
    let best: { place: Place; distanceMeters: number } | null = null;
    for (const r of results) {
      const place = placeFromRow(r);
      const d = haversineMeters(point, place.coordinate);
      if (d <= radiusMeters && (!best || d < best.distanceMeters)) best = { place, distanceMeters: d };
    }
    return best;
  }
}

// ---------------------------------------------------------------- transit

interface StationRow {
  id: string;
  name: string;
  lng: number;
  lat: number;
  line_ids: string | null;
}

const LINE_IDS_SUBQUERY =
  '(SELECT json_group_array(line_id) FROM (SELECT DISTINCT line_id FROM transit_line_stations WHERE station_id = s.id ORDER BY line_id)) AS line_ids';

const stationFromRow = (r: StationRow): TransitStation => ({
  id: r.id,
  name: r.name,
  coordinate: { lng: Number(r.lng), lat: Number(r.lat) },
  lineIds: r.line_ids ? (JSON.parse(r.line_ids) as string[]) : [],
});

export class D1TransitRepo implements TransitRepo {
  constructor(private readonly db: D1Database) {}

  async upsertStations(stations: TransitStationInput[]): Promise<void> {
    await batchChunks(this.db, stations.map(stationUpsert));
  }

  async upsertLine(line: TransitLineInput): Promise<void> {
    await this.db.batch(lineUpsert(line).map((s) => bind(this.db, s)));
  }

  async stationsInBbox(bbox: Bbox, limit: number): Promise<TransitStation[]> {
    const [w, s, e, n] = bbox;
    const { results } = await this.db
      .prepare(`SELECT s.id, s.name, s.lng, s.lat, ${LINE_IDS_SUBQUERY} FROM transit_stations s WHERE s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ? ORDER BY s.id LIMIT ?`)
      .bind(s, n, w, e, limit)
      .all<StationRow>();
    return results.map(stationFromRow);
  }

  async getLine(lineId: string): Promise<{ id: string; name: string; color: string; stations: TransitStation[] } | null> {
    const line = await this.db.prepare('SELECT id, name, color FROM transit_lines WHERE id = ?').bind(lineId).first<{ id: string; name: string; color: string }>();
    if (!line) return null;
    const { results } = await this.db
      .prepare(
        `SELECT s.id, s.name, s.lng, s.lat, ${LINE_IDS_SUBQUERY} FROM transit_line_stations ls JOIN transit_stations s ON s.id = ls.station_id WHERE ls.line_id = ? ORDER BY ls.seq`,
      )
      .bind(lineId)
      .all<StationRow>();
    return { id: line.id, name: line.name, color: line.color, stations: results.map(stationFromRow) };
  }
}

// ---------------------------------------------------------------- drops

interface CampaignRow {
  id: string;
  app_id: string;
  channel: string;
  seed: string;
  spec_json: string;
  starts_at: number;
  ends_at: number;
  created_at: number;
}

const campaignFromRow = (r: CampaignRow): Campaign => {
  const spec = JSON.parse(r.spec_json) as CampaignSpec;
  return {
    ...spec,
    id: r.id,
    appId: r.app_id,
    channel: r.channel,
    seed: r.seed,
    startsAtMs: Number(r.starts_at),
    endsAtMs: Number(r.ends_at),
    createdAt: Number(r.created_at),
  };
};

interface CollectRow {
  app_id: string;
  collect_id: string;
  drop_id: string;
  user_id: string;
  fix_lng: number;
  fix_lat: number;
  fix_accuracy: number;
  fix_timestamp: number;
  collected_at: number;
  receipt: string;
}

const collectFromRow = (r: CollectRow): CollectRecord => ({
  appId: r.app_id,
  collectId: r.collect_id,
  dropId: r.drop_id,
  userId: r.user_id,
  fix: { lng: Number(r.fix_lng), lat: Number(r.fix_lat), accuracyMeters: Number(r.fix_accuracy), timestamp: Number(r.fix_timestamp) },
  collectedAt: Number(r.collected_at),
  receipt: r.receipt,
});

export class D1DropsRepo implements DropsRepo {
  constructor(private readonly db: D1Database) {}

  async insertCampaign(c: Campaign): Promise<void> {
    const spec: CampaignSpec = {
      channel: c.channel,
      type: c.type,
      rarityWeights: c.rarityWeights,
      payloadPool: c.payloadPool,
      area: c.area,
      density: c.density,
      windowMinutes: c.windowMinutes,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      collectRadiusMeters: c.collectRadiusMeters,
    };
    await this.db
      .prepare('INSERT INTO drop_campaigns (id, app_id, channel, seed, spec_json, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(c.id, c.appId, c.channel, c.seed, JSON.stringify(spec), c.startsAtMs, c.endsAtMs, c.createdAt)
      .run();
  }

  async getCampaign(appId: string, campaignId: string): Promise<Campaign | null> {
    const r = await this.db.prepare('SELECT * FROM drop_campaigns WHERE id = ? AND app_id = ?').bind(campaignId, appId).first<CampaignRow>();
    return r ? campaignFromRow(r) : null;
  }

  async campaignsOverlapping(appId: string, channel: string, fromMs: number, toMs: number): Promise<Campaign[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM drop_campaigns WHERE app_id = ? AND channel = ? AND ends_at > ? AND starts_at <= ? ORDER BY id LIMIT 100')
      .bind(appId, channel, fromMs, toMs)
      .all<CampaignRow>();
    return results.map(campaignFromRow);
  }

  async findCollect(appId: string, collectId: string): Promise<CollectRecord | null> {
    const r = await this.db.prepare('SELECT * FROM drop_collects WHERE app_id = ? AND collect_id = ?').bind(appId, collectId).first<CollectRow>();
    return r ? collectFromRow(r) : null;
  }

  async hasUserCollected(appId: string, userId: string, dropId: string): Promise<boolean> {
    const r = await this.db
      .prepare('SELECT 1 AS hit FROM drop_collects WHERE app_id = ? AND user_id = ? AND drop_id = ?')
      .bind(appId, userId, dropId)
      .first<{ hit: number }>();
    return r !== null;
  }

  async lastCollect(appId: string, userId: string): Promise<CollectRecord | null> {
    const r = await this.db
      .prepare('SELECT * FROM drop_collects WHERE app_id = ? AND user_id = ? ORDER BY collected_at DESC LIMIT 1')
      .bind(appId, userId)
      .first<CollectRow>();
    return r ? collectFromRow(r) : null;
  }

  async insertCollect(c: CollectRecord): Promise<InsertCollectResult> {
    try {
      await this.db
        .prepare(
          'INSERT INTO drop_collects (app_id, collect_id, drop_id, user_id, fix_lng, fix_lat, fix_accuracy, fix_timestamp, collected_at, receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(c.appId, c.collectId, c.dropId, c.userId, c.fix.lng, c.fix.lat, c.fix.accuracyMeters, c.fix.timestamp, c.collectedAt, c.receipt)
        .run();
      return 'ok';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE constraint failed/i.test(msg)) throw err;
      return /collect_id/.test(msg) ? 'duplicate_collect_id' : 'duplicate_user_drop';
    }
  }
}

// ---------------------------------------------------------------- webhooks

interface AttemptRow {
  delivery_id: string;
  attempt: number;
  app_id: string;
  event_type: string;
  url: string;
  ok: number;
  response_status: number | null;
  error: string | null;
  attempted_at: number;
}

export class D1WebhooksRepo implements WebhooksRepo {
  constructor(private readonly db: D1Database) {}

  async upsertEndpoint(e: WebhookEndpoint): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO webhook_endpoints (app_id, url, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (app_id) DO UPDATE SET url = excluded.url, secret = excluded.secret, updated_at = excluded.updated_at',
      )
      .bind(e.appId, e.url, e.secret, e.createdAt, e.updatedAt)
      .run();
  }

  async getEndpoint(appId: string): Promise<WebhookEndpoint | null> {
    const r = await this.db
      .prepare('SELECT app_id, url, secret, created_at, updated_at FROM webhook_endpoints WHERE app_id = ?')
      .bind(appId)
      .first<{ app_id: string; url: string; secret: string; created_at: number; updated_at: number }>();
    return r ? { appId: r.app_id, url: r.url, secret: r.secret, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) } : null;
  }

  async recordAttempt(a: DeliveryAttempt): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO webhook_deliveries (delivery_id, attempt, app_id, event_type, url, ok, response_status, error, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(a.deliveryId, a.attempt, a.appId, a.eventType, a.url, a.ok ? 1 : 0, a.responseStatus, a.error, a.attemptedAt)
      .run();
  }

  async listAttempts(appId: string, deliveryId?: string): Promise<DeliveryAttempt[]> {
    const stmt = deliveryId
      ? this.db.prepare('SELECT * FROM webhook_deliveries WHERE app_id = ? AND delivery_id = ? ORDER BY attempted_at, attempt').bind(appId, deliveryId)
      : this.db.prepare('SELECT * FROM webhook_deliveries WHERE app_id = ? ORDER BY attempted_at, attempt LIMIT 500').bind(appId);
    const { results } = await stmt.all<AttemptRow>();
    return results.map((r) => ({
      deliveryId: r.delivery_id,
      attempt: Number(r.attempt),
      appId: r.app_id,
      eventType: r.event_type,
      url: r.url,
      ok: Number(r.ok) === 1,
      responseStatus: r.response_status === null ? null : Number(r.response_status),
      error: r.error,
      attemptedAt: Number(r.attempted_at),
    }));
  }
}

/** All D1-backed repositories for one database binding. */
export function createD1Repos(db: D1Database): {
  keys: D1KeysRepo;
  usage: D1UsageRepo;
  places: D1PlacesRepo;
  transit: D1TransitRepo;
  drops: D1DropsRepo;
  webhooks: D1WebhooksRepo;
} {
  return {
    keys: new D1KeysRepo(db),
    usage: new D1UsageRepo(db),
    places: new D1PlacesRepo(db),
    transit: new D1TransitRepo(db),
    drops: new D1DropsRepo(db),
    webhooks: new D1WebhooksRepo(db),
  };
}
