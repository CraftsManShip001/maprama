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
