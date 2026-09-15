-- Maprama API schema v1 (Cloudflare D1 / SQLite 3.4x with FTS5).
-- Apply: wrangler d1 migrations apply DB --local   (or --remote)
-- Times are INTEGER milliseconds since the Unix epoch unless noted.

-- API keys: only the SHA-256 hex hash of a key is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  key_hash      TEXT NOT NULL UNIQUE,
  app_id        TEXT NOT NULL,
  plan          TEXT NOT NULL CHECK (plan IN ('free', 'pro')),
  monthly_quota INTEGER NOT NULL CHECK (monthly_quota >= 0),
  role          TEXT NOT NULL CHECK (role IN ('client', 'admin', 'server')),
  label         TEXT,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_app ON api_keys (app_id);

-- Usage counters per key, UTC month (YYYY-MM) and unit.
CREATE TABLE IF NOT EXISTS usage_counters (
  key_id        TEXT NOT NULL,
  month         TEXT NOT NULL,
  unit          TEXT NOT NULL CHECK (unit IN ('tile', 'world', 'search', 'transit', 'drops', 'collect')),
  requests      INTEGER NOT NULL DEFAULT 0,
  units         INTEGER NOT NULL DEFAULT 0,
  overage_units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, month, unit)
);

-- Places: POIs (OSM), address points (road-name address DB), stations.
CREATE TABLE IF NOT EXISTS places (
  pk       INTEGER PRIMARY KEY,
  id       TEXT NOT NULL UNIQUE,
  kind     TEXT NOT NULL CHECK (kind IN ('poi', 'address', 'station')),
  name     TEXT NOT NULL,
  address  TEXT,
  category TEXT,
  lng      REAL NOT NULL,
  lat      REAL NOT NULL,
  source   TEXT
);
CREATE INDEX IF NOT EXISTS places_kind_lat_lng ON places (kind, lat, lng);
CREATE INDEX IF NOT EXISTS places_lat_lng ON places (lat, lng);

-- Full-text index: rowid = places.pk; `grams` = space-separated character
-- bigrams + leading unigrams of the normalized name and address
-- (see src/search/normalize.ts `indexTokens`).
CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5 (grams, tokenize = 'unicode61');

-- Public transit.
CREATE TABLE IF NOT EXISTS transit_stations (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lng  REAL NOT NULL,
  lat  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS transit_stations_lat_lng ON transit_stations (lat, lng);

CREATE TABLE IF NOT EXISTS transit_lines (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transit_line_stations (
  line_id    TEXT NOT NULL REFERENCES transit_lines (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  station_id TEXT NOT NULL REFERENCES transit_stations (id),
  PRIMARY KEY (line_id, seq)
);
CREATE INDEX IF NOT EXISTS transit_line_stations_station ON transit_line_stations (station_id);

-- Drop campaigns. Individual drops are generated deterministically, not stored.
CREATE TABLE IF NOT EXISTS drop_campaigns (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL,
  channel    TEXT NOT NULL,
  seed       TEXT NOT NULL,
  spec_json  TEXT NOT NULL,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drop_campaigns_app_channel_time ON drop_campaigns (app_id, channel, ends_at, starts_at);

-- Verified collects.
CREATE TABLE IF NOT EXISTS drop_collects (
  app_id        TEXT NOT NULL,
  collect_id    TEXT NOT NULL,
  drop_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  fix_lng       REAL NOT NULL,
  fix_lat       REAL NOT NULL,
  fix_accuracy  REAL NOT NULL,
  fix_timestamp INTEGER NOT NULL,
  collected_at  INTEGER NOT NULL,
  receipt       TEXT NOT NULL,
  PRIMARY KEY (app_id, collect_id),
  UNIQUE (app_id, user_id, drop_id)
);
CREATE INDEX IF NOT EXISTS drop_collects_user_time ON drop_collects (app_id, user_id, collected_at);

-- Webhooks: one endpoint per app; every delivery attempt is recorded.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  app_id     TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  secret     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id     TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  app_id          TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  url             TEXT NOT NULL,
  ok              INTEGER NOT NULL CHECK (ok IN (0, 1)),
  response_status INTEGER,
  error           TEXT,
  attempted_at    INTEGER NOT NULL,
  PRIMARY KEY (delivery_id, attempt)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_app_time ON webhook_deliveries (app_id, attempted_at);
