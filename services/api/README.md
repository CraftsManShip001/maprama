# @maprama/api

The paid hosted Maprama service, next to the open-source SDK: world data and
vector tiles, place search and reverse geocoding, public transit, dynamic
drops with server-verified collection, API keys with a monthly free tier plus
usage-based overage, and signed webhooks.

Runs on Cloudflare Workers ([Hono](https://hono.dev)) with D1 (SQLite) and R2.
Everything is testable locally without a Cloudflare account.

## Architecture

```
                 ┌──────────────────────── createApp(deps) (Hono) ─────────────────────────┐
  SDK / app ───▶ │ cors → authenticate (Bearer | ?key= for maps) → requireRole → meter(unit) │
                 │ routes: maps · search · transit · drops · webhooks · usage               │
                 └────────────┬──────────────────────────────┬─────────────────────────────┘
                              │ repository interfaces (src/deps.ts)
          ┌───────────────────┼───────────────────┬──────────────────────────┐
   src/adapters/memory   src/adapters/d1       src/adapters/r2.ts       clock · crypto · fetch
   (tests, dev:local)    (D1 + FTS5)           (PMTiles range reads)    (webhook delivery)
```

- `src/app.ts`: `createApp(deps: ServiceDeps)`; no global state, all I/O injected.
- `src/worker.ts`: Workers entry; binds `DB` (D1), `TILES` (R2), `RECEIPT_SECRET`.
- `src/deps.ts`: `KeysRepo`, `UsageRepo`, `PlacesRepo`, `TransitRepo`, `DropsRepo`, `WebhooksRepo`, `BlobStore`, `Clock`.
- `src/verify.ts` (`@maprama/api/verify`): pure Web Crypto helpers for app servers. It has no imports.
- `migrations/0001_init.sql`: D1 schema.
- `openapi.yaml`: every endpoint, error code and auth scheme.
- Contract types (`LngLat`, `DropSpec`, `WorldData`, ...) come from `@maprama/protocol`.

### Endpoints and billable units

| Endpoint | Auth / role | Unit (weight) |
| --- | --- | --- |
| `GET /v1/worlds/:region.json` | any key; `?key=` allowed | `world` (20) |
| `GET /v1/tiles/:tileset.json` | any key; `?key=` allowed | `tile` (1) |
| `GET /v1/tiles/:tileset/:z/:x/:y.mvt` | any key; `?key=` allowed | `tile` (1) |
| `GET /v1/search?q=&near=&limit=` | any key | `search` (5) |
| `GET /v1/reverse?lng=&lat=` | any key | `search` (5) |
| `GET /v1/transit/stations?bbox=` | any key | `transit` (2) |
| `GET /v1/transit/lines/:lineId` | any key | `transit` (2) |
| `POST /v1/drops/campaigns` | `admin`, `server` | not metered |
| `GET /v1/drops/nearby?lng&lat&radius&channel` | any key | `drops` (2) |
| `POST /v1/drops/collect` | any key | `collect` (10) |
| `POST /v1/webhooks`, `POST /v1/webhooks/test` | `admin` | not metered |
| `GET /v1/receipts/secret` | `admin` | not metered |
| `GET /v1/usage` | any key | not metered |

Weights live in `src/config.ts` (`UNIT_WEIGHTS`). A request is billable when it
returns a status below 400, or 422 from collect (the verification work was done).
Free keys get `429 QUOTA_EXCEEDED` once `used + weight > monthlyQuota`. Pro keys
keep working, and units beyond the quota are recorded as `overageUnits`.
Counters are per key per UTC month. Responses carry `X-Maprama-Usage: used/quota`,
`X-RateLimit-Limit` and `X-RateLimit-Remaining`.

### Keys

Keys look like `mpr_<43 base64url chars>`. Only the SHA-256 hex hash is stored,
together with `appId`, `plan` (`free|pro`), `monthlyQuota` and `role`
(`client|server|admin`). Lookup is by hash, followed by a constant-time compare.
Raw keys are never logged; the error handler logs only `err.message`, never URLs
or headers.

### Maps

WorldData JSON lives in R2 at `worlds/<region>.json`. It is served with `ETag`,
`Cache-Control: private, max-age=86400, stale-while-revalidate=604800` and
`If-None-Match` → 304. The cache is `private` because responses are metered and
authenticated, so shared caches must not serve them.

Vector tiles are PMTiles v3 archives at `tiles/<tileset>.pmtiles`. They are read
through `pmtiles` with a custom `Source` that does R2 byte-range reads
(`BlobRangeSource`). pmtiles returns decompressed tile bytes, and the service then
picks the transfer encoding:

- `tileEncoding: 'app'` (Node, tests): gzip with `CompressionStream` when the client accepts gzip.
- `tileEncoding: 'runtime'` (set in `worker.ts`): set `Content-Encoding: gzip` and let the Workers runtime encode the body.

Empty, missing and out-of-zoom tiles return 204. TileJSON is built from the
archive header and metadata. When the request used `?key=`, the tile URL template
includes the same key.

### Search

Place records (`poi`, `address`, `station`) are indexed with character bigrams
plus leading unigrams of the NFKC-normalized, whitespace/punctuation-stripped name
and address (`src/search/normalize.ts`):

- The memory adapter keeps an inverted index.
- The D1 adapter uses an FTS5 table (`places_fts`, `unicode61` tokenizer) whose tokens are those same grams. With `near`, it first takes the nearest matches within about 20 km, then fills with national bm25 matches.

Ranking is shared (`src/search/rank.ts`): exact name 1.0, name prefix 0.9, name
substring 0.8, address substring 0.75, otherwise bigram overlap × 0.7. With `near`,
`score = 0.7·text + 0.3·1/(1 + d/1 km)`. One-character queries match word prefixes.
`/v1/reverse` returns the nearest `address` place within 200 m.

### Drops

A campaign has `{channel, type, rarityWeights, payloadPool, area, density,
windowMinutes, startsAt, endsAt, collectRadiusMeters}` plus a secret random `seed`
that is never returned. Individual drops are never stored. For window `w` and
geohash-6 cell `c`, a seeded PRNG (`cyrb128 → sfc32` over `seed|w|c`) yields
`floor(density·cellArea)` drops, plus one more with probability equal to the
fraction. Positions outside the area are skipped with stable indices. Every
client therefore sees identical drops, and the verifier regenerates a drop from
its id: `d1.<campaignId>.<window>.<geohash>.<index>`.

`POST /v1/drops/collect` `{dropId, collectId, userId, fix:{lng,lat,accuracyMeters,timestamp}}`
checks, in order:

1. `collectId` already used: the same drop and user returns the original receipt (`replayed: true`); otherwise `409 COLLECT_ID_CONFLICT`.
2. The drop exists (`DROP_NOT_FOUND`) and is in the current or previous window (`DROP_EXPIRED`).
3. `|fix.timestamp − now| ≤ 2 min` (`STALE_FIX`).
4. `distance ≤ collectRadiusMeters + min(accuracyMeters, 30)` (`TOO_FAR`).
5. The user has not collected this drop (`ALREADY_COLLECTED`; also enforced by a unique index).
6. The implied speed from the user's last verified collect is ≤ 90 m/s (`TELEPORT`; subway and car are allowed). Elapsed time is the gap between the two server verification times (`collectedAt`, minimum 1 s), never the client fix timestamps: those may each be skewed by up to 2 minutes and would otherwise add fake travel time.

On success the service stores the collect, returns `{receipt}` and enqueues a
`drop.collected` webhook via `waitUntil`.

The receipt is `base64url(canonicalJSON(claims)) + "." + base64url(HMAC-SHA256)`,
with claims `{v, appId, dropId, collectId, userId, payload, collectedAt, type, rarity}`.
It is signed with a per-app secret derived as
`HMAC-SHA256(RECEIPT_SECRET, "maprama-receipt:v1:" + appId)`, so one app cannot
forge another app's receipts. Read it with `GET /v1/receipts/secret` (admin,
returns `{receiptSecret}`, no webhook needed). `POST /v1/webhooks` also returns it.

### Webhooks

`POST /v1/webhooks {url, rotateSecret?}` (admin) stores one endpoint per app. A
`whsec_...` signing secret is generated when the endpoint is first created, or
when `rotateSecret: true` is sent. Otherwise only the URL changes and the
existing secret is returned (`secretRotated: false`), so already-configured
verifiers keep working.

Webhook URLs must be `https` on a public hostname. The service rejects
credentials, IP-literal hosts (IPv4 and IPv6, so all private, link-local and
loopback addresses), single-label hosts, and `localhost`, `*.local`,
`*.internal`, `*.localdomain` and `*.home.arpa` names. `npm run dev:local` sets
`options.allowInsecureLocalWebhooks`, which additionally allows `localhost`,
`127.0.0.1` and `[::1]` over http. The option is off by default and in
`src/worker.ts`. Hostnames that resolve to private addresses via DNS cannot be
detected at registration time; on Workers, outbound `fetch` cannot reach private
networks.

Delivery is a `POST` with JSON body and these headers:

```
Maprama-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
Maprama-Event: drop.collected | webhook.test
Maprama-Delivery: evt_...
```

Delivery makes up to 3 attempts, with 1 s and 4 s backoff, an 8 s timeout each and
`redirect: manual`. Every attempt is recorded in `webhook_deliveries`.
`POST /v1/webhooks/test` delivers synchronously and returns the attempts.

## Verifying webhooks and receipts (Node app server)

```ts
import express from 'express';
import { verifyWebhookSignature, verifyReceipt } from '@maprama/api/verify';

const app = express();
app.post('/maprama/webhook', express.text({ type: 'application/json' }), async (req, res) => {
  const sig = await verifyWebhookSignature(req.body, req.get('Maprama-Signature'), process.env.MAPRAMA_WEBHOOK_SECRET!);
  if (!sig.ok) return res.status(400).send(sig.reason); // 'malformed' | 'mismatch' | 'expired'
  const event = JSON.parse(req.body);
  if (event.type === 'drop.collected') {
    const receipt = await verifyReceipt(event.data.receipt, process.env.MAPRAMA_RECEIPT_SECRET!);
    if (receipt.ok) await grantReward(receipt.claims.userId, receipt.claims.dropId, receipt.claims.payload); // idempotent on dropId+userId
  }
  res.sendStatus(204);
});
```

Always verify against the **raw** body string. Receipts forwarded by your client
app can be checked with the same `verifyReceipt`.

## Security model

- **`userId` is not authenticated by this service.** `POST /v1/drops/collect`
  accepts `userId` from the request body, and `client` keys (shipped inside
  mobile apps) may call it. A modified client can therefore submit collects under
  another `userId`, which also sidesteps the per-user `ALREADY_COLLECTED` and
  `TELEPORT` checks. A valid receipt proves that the service verified the drop,
  position and timing for the `userId` in the request. It does not prove who
  that user is.
- **App servers must bind `receipt.userId` to their own authenticated user**
  before granting a reward. Reject a receipt forwarded by a session whose user
  differs from `claims.userId`, and grant idempotently on `dropId + userId`.
- **Planned follow-up:** server-role forwarding (only `server` keys may call
  collect, via the app backend) or signed user tokens issued by the app server,
  so the service can authenticate `userId` itself.
- Anti-teleport timing uses server verification times only (see Drops).
- Webhook URLs are restricted to public https hostnames (see Webhooks).

## Local development

```sh
# from the repo root
npm install
npm run build -w @maprama/protocol   # the root build runs in folder order

cd services/api
npm test                             # vitest: in-memory adapters + real D1 adapters on node:sqlite
npm run typecheck
npm run build                        # tsc → dist/ (library + @maprama/api/verify)

# Node dev server with in-memory storage; prints a dev client key and admin key
npm run dev:local -- --port 8787 --world seongsu=../../tools/osm/samples/seongsu.world.json --tiles seongsu=./seongsu.pmtiles
curl -H "Authorization: Bearer $KEY" 'http://localhost:8787/v1/search?q=성수역'
```

The D1 adapters are exercised in tests against Node's built-in `node:sqlite`
(FTS5, JSON1) through a small D1 API shim (`test/helpers/d1-shim.ts`), and the
migration is applied there too.

Workers runtime locally (Miniflare; no account needed):

```sh
npx wrangler d1 migrations apply DB --local
npx tsx scripts/create-key.ts --app my-app --plan free --role client     # prints key + SQL
npx wrangler d1 execute DB --local --command "<printed INSERT>"
npx tsx scripts/seed-from-world.ts path/to/seongsu.world.json --region seongsu --out seed.sql
npx wrangler d1 execute DB --local --file seed.sql
npx wrangler r2 object put maprama-tiles/worlds/seongsu.json --local --file path/to/seongsu.world.json
echo 'RECEIPT_SECRET="local-dev-secret-at-least-32-characters"' > .dev.vars
npm run dev                          # wrangler dev --local
```

### Data import

- `scripts/seed-from-world.ts <world.json> [--region r] [--out f]` converts WorldData POIs and stations into `places` and `transit_stations` SQL. Positions are converted from world units with the protocol projection.
- `scripts/import-addresses.ts <file> [--encoding euc-kr] [--crs EPSG:5179|EPSG:4326] [--out f]` reads Korean road-name address DB text and emits `address` places.
  - Input is `|`-delimited (the official format) or CSV. Official files are CP949, so pass `--encoding euc-kr`.
  - Columns come from a Korean header row if one is present. Otherwise the default 18-column building-entrance layout is used: 시군구코드 | 출입구일련번호 | 법정동코드 | 시도명 | 시군구명 | 읍면동명 | 도로명코드 | 도로명 | 지하여부 | 건물본번 | 건물부번 | 건물명 | 우편번호 | 건물용도분류 | 건물군여부 | 관할행정동 | X좌표 | Y좌표.
  - Required columns: 시도명, 시군구명, 도로명, 건물본번, X좌표, Y좌표.
  - Coordinates are UTM-K (EPSG:5179) by default.
  - Check the column order against the release notes of the file you download from juso.go.kr; use a header row if it differs.
  - Fixture: `test/fixtures/addresses-sample.txt` has 5 illustrative rows, not real DB records.
- `scripts/create-key.ts --app <id> [--plan free|pro] [--role client|server|admin] [--quota n]` prints a new key once, plus the hash-only `INSERT`.
- Transit lines have no importer yet. Use `TransitRepo.upsertLine` or insert into `transit_lines` / `transit_line_stations`.

## Deployment

1. `npx wrangler d1 create maprama-api`, then put the `database_id` into `wrangler.toml` (the committed value is a placeholder).
2. `npx wrangler r2 bucket create maprama-tiles`.
3. `npx wrangler secret put RECEIPT_SECRET` (≥ 32 random characters). Rotating it invalidates existing receipts and changes every app's `receiptSecret`.
4. `npx wrangler d1 migrations apply DB --remote`.
5. Upload data: `wrangler r2 object put maprama-tiles/tiles/<tileset>.pmtiles --file ...` and the world JSON files. Seed D1 with the scripts above (`--remote`).
6. `npx wrangler deploy` (or `npm run build:worker` for a dry-run bundle into `dist/worker`).

## Cost notes

- **R2** has no egress fees, so tile and world bandwidth is free. Each tile request costs about one R2 Class B read, plus a few for directory reads that the per-isolate archive cache (`TileArchives`) usually avoids. World JSON is one Class B read, and a 304 is a `head`.
- **D1**: every metered request does one `SUM` read and one upsert write on `usage_counters`. At high tile volume this dominates D1 writes. Before launch, move tile metering to batched counters (Workers Analytics Engine or a Durable Object per key) and keep D1 for billing rollups.
- **Search** runs FTS5 queries against D1 (reads only). Nationwide address data is roughly 6 to 10 million rows plus FTS; check the D1 database size limit for your plan.
- **Webhooks** run in `waitUntil` and are not billed to the app. Retries happen within the same invocation (about 30 s worst case). Durable retries (Queues) are a follow-up.
- Billable units per endpoint are listed in the table above. Campaign management, webhooks and `/v1/usage` are free.
