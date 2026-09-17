# @maprama/tiles

Builds the **nationwide MTIL v1 / PMTiles archive** the engine streams from, and
reads one back.

The format is specified in [`design/tile-format.md`](../../design/tile-format.md)
(MTIL v1). That spec was proved out by [`tools/tile-spike`](../tile-spike/README.md),
which measured tile sizes and showed a PMTiles archive can carry our payload.
This package is the production tool that spike pointed at: leaf directories, a
single `.pbf` scan for many regions, a resumable nationwide driver, per-layer
source routing, and tests.

## Why a separate package rather than a `maprama-osm` subcommand

`@maprama/osm` is a **source adapter**: OSM (Overpass or `.pbf`) in, `WorldData`
out. Tiling is downstream of that and deliberately source-agnostic — the Korean
national building dataset (GIS건물통합정보) is expected to supply `buildings`
before long, and a tiler living inside the OSM CLI would be wired to one source
by construction. So `@maprama/tiles` depends on `@maprama/osm` as *one registered
source* (`src/osm-source.ts`) and knows nothing else about OSM.

`tools/tile-spike` was left where it is: `design/tile-format.md` cites it for the
numbers behind the format, and those numbers should stay reproducible.

## Commands

```sh
npm run build -w @maprama/protocol && npm run build -w @maprama/osm && npm run build -w @maprama/tiles

node tools/tiles/dist/bin.js survey  --pbf korea.osm.pbf --work .work
node tools/tiles/dist/bin.js build   --pbf korea.osm.pbf --work .work --out korea.pmtiles
node tools/tiles/dist/bin.js verify  korea.pmtiles
node tools/tiles/dist/bin.js inspect korea.pmtiles --at 127.027,37.497
node tools/tiles/dist/bin.js water   korea.pmtiles --at 126.9971,37.5200
```

`survey` is one pass over the `.pbf` counting nodes per chunk cell; `build` runs
it for you and caches the result. Neither the extract nor the archive belongs in
the repository — OSM-derived data is ODbL and the repo is Apache-2.0.

## How a nationwide build is organised

```
survey ─▶ plan ─▶ [ batch: one .pbf scan ─▶ per chunk: sources ─▶ tiles ─▶ shard ] ─▶ assemble
```

**Chunk.** One slippy tile at z10 (~31 km square), extracted with a 0.01°
(~1.1 km) margin so a feature a core tile owns is complete. Every z13 and z15
tile nests inside exactly one chunk, so ownership is integer arithmetic and no
tile is produced twice.

**One scan per batch, not per chunk.** `extractFromPbf(file, bboxes[])` serves N
areas from a single read. A 287 MB national extract read once per chunk would be
295 reads; batched by a node budget it is about a dozen.

**Resumable.** Each chunk writes `shards/<id>.bin` and then, last,
`shards/<id>.json`. A manifest on disk means that chunk is done; a run
interrupted anywhere costs one chunk, not the run. Re-running `build` against the
same `--work` resumes. `--fresh` starts over.

**Deterministic.** Same input, same bytes — pinned by `test/build.test.ts`, which
builds the same area twice with different batch groupings and compares the files
byte for byte. Batching is a scheduling decision and must never reach the output.

**Assembled by streaming.** PMTiles orders tiles along a Hilbert curve, which is
recursive: a chunk's descendants occupy a contiguous id range. Visiting chunks in
id order therefore emits tiles already sorted, so the archive is assembled
without ever holding it in memory.

## Measured — the whole country, once

Built from the Geofabrik `south-korea-latest.osm.pbf` (287,435,662 B, replication
timestamp in the extract), on an Apple silicon laptop, one process, z13 + z15,
`--chunk-zoom 10 --node-budget 4000000`:

| | |
| --- | --- |
| archive | **133,050,634 B (126.9 MiB)** |
| tiles | **109,455** — 102,684 at z15, 6,771 at z13 |
| wall clock | **29.5 min** (12 batches, 295 chunks; ~9 s of it the node survey) |
| peak RSS | **3,267 MiB** |
| root directory | **149 B**, 27 leaves totalling 196,188 B at 4,096 entries each |
| cold start | header + root + metadata = **479 B**, one 16 KiB request |
| resume | dropping 2 shard manifests and re-running: 0.6 min, **byte-identical archive** (same SHA-256) |

Tile sizes (gzip, bytes):

| | p50 | p90 | p99 | p99.9 | max | mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| z15 | 649 | 1,951 | 10,454 | 26,052 | 60,583 | 1,144 |
| z13 | 1,065 | 4,042 | 27,269 | 50,272 | 81,349 | 2,266 |

**The archive is about eight times smaller than `design/tile-format.md` §8.2
extrapolated** (0.4–2.1 GB, "1 GB 내외"). The tile *count* was predicted well
(102,684 non-empty z15 tiles against an estimated 46,574–107,066); the density
was not. §8.2 took eight urban and suburban samples and applied one KB/km²
figure to the whole country, but the median z15 tile in the real archive is
649 B — a couple of roads through a mountain — while only 77 tiles exceed the
28.5 KB the Gangnam sample predicted for everything. The distribution is far more
skewed than a mean can express, which is why the table above is percentiles.

Largest measured anchor overhang: **4,335 units = 513 m at z15**, against the
45.9 m the spike saw in Seongsu. The 0.01° (~1.1 km) chunk margin covers it with
roughly 2× headroom; anything that grows past that would need `--pad` raised, and
it is the one number to re-check if the source data ever changes.

## Swapping a layer's data source

Everything about *where a layer comes from* lives in `src/sources.ts`:

```ts
export const DEFAULT_LAYER_ROUTING: LayerRouting = {
  roads: 'osm', buildings: 'osm', water: 'osm', parks: 'osm',
  pois: 'osm', stations: 'osm', districts: 'osm',
};
```

To put national buildings in: implement a `TileSource` with `id: 'kr'` and
`provides: ['buildings']`, register it, and change one line to
`buildings: 'kr'`. Nothing in the tiler, the encoder, the archive writer or the
driver changes — none of them knows what a source is beyond its id.

The archive's `attribution` string table falls out of the same table: it is the
registered sources' lines, and **each tile stores the indices of the sources that
actually put something in it** (`design/tile-format.md` §4.2), so a tile with a
national building and a tile without get different index arrays for free. That
also keeps ODbL and CC BY separable per tile, which matters because the data
licences differ from the repository's.

## Layout

| file | |
| --- | --- |
| `src/mercator.ts` | slippy-tile maths; quantisation to whole-zoom integers |
| `src/geometry.ts` | clipping, footprint anchors, the synthetic-edge test |
| `src/mtil.ts` | MTIL v1 encoder / decoder |
| `src/tiler.ts` | features → tiles (anchor-owned vs clipped), overview profile |
| `src/pmtiles.ts` | PMTiles v3 writer **with leaf directories**, written from the spec |
| `src/sources.ts` | the layer-source registry and attribution table |
| `src/osm-source.ts` | the `osm` source: batched `.pbf` scan + `buildWorld` |
| `src/chunks.ts` | the chunk grid, planning and batching |
| `src/build.ts` | the resumable driver |
| `src/reader.ts` | reading back with the **official** `pmtiles` package |

`src/pmtiles.ts` imports nothing from the `pmtiles` package — not even the tile
id — so `test/pmtiles.test.ts` is two independent implementations of the same
spec agreeing, which is the only check worth anything for hand-written bytes.

## Known gaps

- **The overview level filters, it does not simplify.** Per-zoom Douglas–Peucker
  is the untested next step `design/tile-format.md` §1.2 names.
- **`design/tile-format.md` §3.2 states the synthetic-edge rule as "both
  endpoints on the tile boundary (0 or `extent`)".** Geometry is clipped to the
  tile **plus the buffer**, so the edges a clip creates lie on `-buffer` and
  `extent + buffer`, and the rule as worded finds none of them. `maprama-tiles
  water` shows this on the Han river. `isSyntheticEdge()` here tests the real
  clip square; the spec wording needs the same correction.
- **Polygons still have no holes**, inherited from `WorldData`.
- **Batching is greedy, not packed.** A chunk whose node count alone exceeds the
  budget gets a scan to itself; in the national run that happened three times
  (batches of 1, 2 and 9 chunks), costing a few minutes of re-reading. Sorting
  chunks by cost before packing would fix it, at the price of losing the archive
  order that the streaming assembly depends on — so it would need the shard
  writing and the assembly order decoupled first.
