# @maprama/osm

Builds Maprama [`WorldData`](https://github.com/CraftsManShip001/maprama/blob/main/packages/protocol/src/world.ts) JSON from
OpenStreetMap data (via the Overpass API). It can optionally add building
heights from the Korean national building dataset, and — where OSM has no
building at all — the buildings themselves.

- CLI: `maprama-osm` (`fetch`, `build`, `sample`)
- Library: `buildWorld(raw, options)`, a pure function you can unit-test without network access
- Sample world: [`samples/seongsu.world.json`](samples/seongsu.world.json) (Seongsu-dong, Seoul), licensed under ODbL 1.0 (see [Licenses and attribution](#licenses-and-attribution))

## Install

Requires Node.js 22.12+.

```sh
npm i -D @maprama/osm        # or run it once: npx @maprama/osm --help
```

## Build from the monorepo

```sh
npm run build -w @maprama/protocol   # the contract must be built first
npm run build -w @maprama/osm
npm test -w @maprama/osm
```

## Commands

```sh
# 1. Download raw OSM data (Overpass JSON, full geometry) for a bbox: south,west,north,east
maprama-osm fetch --bbox 37.5410,127.0520,37.5480,127.0610 --out raw.json

# 2. Convert it to WorldData
maprama-osm build --raw raw.json --out world.json --name "Seongsu-dong, Seoul"

# Both steps for a built-in sample area
maprama-osm sample seongsu
```

Regenerate the checked-in sample from the repository root:

```sh
npm run build -w @maprama/protocol && npm run build -w @maprama/osm && npm run sample:seongsu -w @maprama/osm
```

This writes `tools/osm/samples/seongsu.world.json`. It also writes the raw
payload to `tools/osm/.cache/samples/seongsu.raw.json`.

### `fetch`

| Option | Default | |
| --- | --- | --- |
| `--bbox s,w,n,e` | required | Bounding box in degrees |
| `--out <file>` | required | Raw Overpass JSON (with a `maprama` metadata block holding the bbox) |
| `--endpoint <url>` | see below | Repeatable. Endpoints are tried in order |
| `--timeout <s>` | `90` | Per-request timeout |
| `--no-cache` | | Skip the response cache |

### `build`

| Option | Default | |
| --- | --- | --- |
| `--raw <file>` | required | Output of `fetch` (any Overpass `[out:json]` + `out geom` payload works) |
| `--out <file>` | required | WorldData JSON |
| `--name <name>` | required | World name |
| `--bbox s,w,n,e` | `raw.maprama.bbox`, else the data extent | Clip box |
| `--origin lat,lng` | bbox center | Geographic point mapped to world `(0, 0)` |
| `--unit-meters <m>` | `8` | Meters per world unit |
| `--simplify-meters <m>` | `0.5` | Douglas–Peucker tolerance |
| `--kr-buildings <file>` | | Korean building GeoJSON (see below) |
| `--kr-fill-missing` | off | Also emit buildings for `--kr-buildings` polygons that OSM does not have ([filling gaps](#filling-gaps-in-osm-building-coverage)). Requires `--kr-buildings` |
| `--poi-snap-meters <m>` | `20` | Radius for [attaching a POI to a building](#attaching-pois-to-buildings); `0` records containment but never moves a POI |
| `--precision <n>` | `2` | Decimal places of output coordinates (world units) |
| `--include-sidewalks` | off | Keep `footway=sidewalk\|crossing` ways |

The output is written one feature per line. That keeps it compact and easy to
diff in git. The CLI validates the written file with `validateWorldData` and
warns if it grows past 3 MB.

`build` and `sample` print a JSON stats block on stdout. Besides the per-layer
counts it reports `buildingsFromOsm`, `buildingsFilled` (generated from the
national dataset) and `krFillSkipped` (national polygons inside the bbox that
OSM already had), plus `krIndexed` and `krMatches`, and the POI join's
`poisInBuilding` / `poisSnapped` / `poisUnattached`.

### Overpass endpoints

Default order: `https://overpass-api.de/api/interpreter`, then
`https://maps.mail.ru/osm/tools/overpass/api/interpreter`, then
`https://overpass.private.coffee/api/interpreter`. The client makes two passes
over the list, with exponential backoff between attempts. It treats HTTP
429/5xx errors, non-JSON bodies and Overpass `remark` runtime errors as
retryable. HTTP 400 (a bad query) is never retried.

- Requests are `POST` with the form field `data`. A `User-Agent` header is always sent, because Overpass servers answer `406` without one.
- `MAPRAMA_OVERPASS_ENDPOINT` takes a comma-separated list that overrides the defaults. `MAPRAMA_OSM_USER_AGENT` overrides the User-Agent.
- Responses are cached in `tools/osm/.cache/overpass-<sha256(query)>.json` (gitignored). Delete the cache or pass `--no-cache` to refresh.
- Please respect the [Overpass usage policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html): keep bboxes small and rely on the cache.

## Mapping rules

World space follows `@maprama/protocol`: `+x` = east, `z` = −north, in world
units of `unitMeters` meters. Ids are `w<wayId>`, `r<relationId>` and
`n<nodeId>`. When a way is split by the bbox, or a relation has several outer
rings, the pieces are suffixed `_0`, `_1`, and so on. Buildings generated from
the national dataset use a fourth prefix, `k` (see
[filling gaps](#filling-gaps-in-osm-building-coverage)).

**Footprints and polygons** are projected, simplified and clipped to the bbox
(Sutherland–Hodgman). They are then rounded, cleaned of duplicate and collinear
vertices, and wound counter-clockwise. Counter-clockwise here means a positive
shoelace area computed over `[x, z]` as stored, which matches the protocol test
fixtures. Rings are open (not closed). Buildings with identical footprints are
deduplicated.

**Roads** (`highway=*` ways, split where they cross the bbox edge):

| OSM | `cls` |
| --- | --- |
| `motorway`, `trunk`, `primary`, `secondary` (+ `_link`) | `arterial` |
| `tertiary`, `residential`, `unclassified`, `living_street`, named `service` | `local` |
| `footway`, `path`, `pedestrian`, `service`, `track`, `steps`, `cycleway` | `alley` |
| `construction`, `proposed`, `platform`, `area=yes`, `indoor=yes`, … | skipped |

`bridge=*` (other than `no`) sets `bridge: true`. Names come from `name:ko`, falling back to `name`.

**Building height** is resolved in this order:

1. Korean dataset `HEIGHT` (m)
2. Korean dataset `GRND_FLR` × 3.2 m
3. `height` tag
4. `building:levels` × 3.2 m
5. A heuristic by `building=*`: `apartments` 45 m, `commercial`/`office` 30 m, `house`/`residential` (and other low residential values) 9 m, `retail` 7 m, anything else 12 m

`levels` is set only when a floor count is known. Heights are stored in world
units (meters ÷ `unitMeters`).

**Facade kind** is assigned as follows:

- `glass`: 60 m or taller, or glass material tags
- `apartment`: `apartments`/`residential` buildings of 20 m or more
- `office`: commercial, office and civic buildings
- `brick`: small buildings, pre-1990 buildings (by `start_date`), `retail` and houses

**POIs** need a name and must lie inside the bbox. Ways and relations use an
interior point of their area.

| OSM | `cat` |
| --- | --- |
| `railway=station`, `station=subway` | `subway` (also `stations[]`) |
| `shop=music`, or a shop/amenity whose name contains `LP`, `레코드` or `음반` | `music` |
| `amenity=cafe` | `cafe` |
| `shop=convenience\|supermarket` | `store` |
| `amenity=school\|kindergarten` | `school` |
| `shop=books` | `book` |
| `leisure=park` | `park` |
| `place=square` | `plaza` |

Station nodes with the same name within 500 m are merged into one station at
their mean position. `plaza` is the named square closest to the origin, if
there is one.

### Attaching POIs to buildings

A POI node in OSM is usually **not** inside the building it describes: mappers
put it at the parcel centre, at the entrance, or by the road, and the building
is a separate `building=*` way. Drawn as a pin on a 2.5D map, such a POI stands
in the street next to its building.

After the buildings are final (including the `--kr-fill-missing` pass), each POI
is therefore joined to one:

| Case | Result |
| --- | --- |
| a footprint contains the POI | `buildingId` is set; the position does not move |
| the nearest footprint is within `--poi-snap-meters` (default 20) | the POI is moved just inside that footprint and gets `buildingId`, `snapped: true` and `snapDistanceMeters` |
| nothing is in range | nothing is added — the POI stays exactly where OSM put it |

`plaza`, `park` and `subway` POIs are **never** joined: a square and a park are
open space, and a merged station sits at the mean of its entrances, usually in
the middle of a road. Moving them into the nearest shop would be wrong, and
`world.plaza` is derived from the plaza POI's own position.

All three fields are optional additions to `WorldData` v1, so a world built
before this existed still loads, and a world built with it still loads in an
engine that ignores them.

**Why 20 m.** Measured over five Korean areas (Gangnam, Seongsu, Jeonju,
Bundang, Gurye — 171 POIs, 2 460 buildings), 25 % of the POIs fall outside every
footprint. Of the 30 joinable ones, snapping recovers 12 at 5 m, 20 at 15 m,
**20 at 20 m** and more only past 25 m. 20 m is where the second-best candidate
is still almost never a tie and the radius stays inside one city block: Korean
back streets are 6–8 m wide, while 40 m crosses an arterial (Gangnam-daero is
~50 m) and would attach a shop to the building on the far side of the road — a
worse error than leaving the POI in open space.

Across those five areas the join takes joinable POIs attached to a building from
**80.8 % to 93.6 %**. The remaining 6.4 % have no building mapped in OSM at all;
no radius fixes that. `--poi-snap-meters 0` keeps the containment check and
turns the moving off.

Two POIs outside the same corner of a building can clamp to the same point
inside it (two shops in one building is the common case); the collision pass
then shows one of them.

A square is often a genuinely open space, so `build` writes a warning to stderr
when the emitted `plaza` is more than 15 m from every building footprint (and is
not inside one):

```
warning: plaza "성수광장" at (0.25, 0.38) stands in open space — the nearest building footprint is 21.6 m away.
  That is fine, and the plaza is emitted as-is; but a renderer that anchors something at world.plaza will have nothing under it.
```

Nothing changes in the output — the plaza is real data and is written either
way. The warning exists because `plaza` is an anchor point, and a map that puts
a marker, a model or a geofence there should know there is no building under it.
Renderers must not invent one: Maprama's engine draws the plaza ground and
nothing else.

**Other layers:**

- **Districts:** `place=neighbourhood|quarter|suburb` nodes, plus one label per named water body (`water: true`).
- **Water:** `natural=water`, `waterway=riverbank` and `water=river` closed ways and multipolygon relations. Outer rings are assembled from member ways, which covers large rivers such as 한강.
- **Parks:** `leisure=park|garden` and `landuse=grass|recreation_ground`.

### Limitations

- WorldData polygons have no holes, so inner rings (courtyards, islands) are dropped.
- Clipping a concave polygon against the bbox can leave zero-width edges along the bbox border.
- Stations are only taken from inside the bbox.

## Korean building heights (optional)

The national **GIS건물통합정보** dataset (국가공간정보포털, <https://www.nsdi.go.kr>)
provides footprints with attributes including `GRND_FLR` (above-ground floors)
and `HEIGHT` (m). It is distributed as SHP/CSV downloads per region, not as a
keyless API. Download the SHP for your area, then convert it to WGS84 GeoJSON
clipped to your bbox:

```sh
# Source CRS is usually EPSG:5186 (Korea 2000 / Central Belt 2010); some exports use EPSG:5179 (UTM-K).
ogr2ogr -f GeoJSON kr.geojson AL_D010_11_YYYYMMDD.shp \
  --config SHAPE_ENCODING CP949 \
  -s_srs EPSG:5186 -t_srs EPSG:4326 \
  -spat 127.052 37.541 127.061 37.548 -spat_srs EPSG:4326 \
  -select GRND_FLR,HEIGHT \
  -lco RFC7946=YES

maprama-osm build --raw raw.json --out world.json --name "Seongsu-dong, Seoul" --kr-buildings kr.geojson
```

(The `.shp` name above is an example. Use the file from your download, and
check its `.prj` for the actual source CRS.)

Join rule: each OSM footprint takes the Korean polygon that covers at least 50%
of the footprint's area (the largest such overlap). If none does, it takes the
smallest Korean polygon containing the footprint centroid. Property names are
matched case-insensitively. Features with neither a positive `HEIGHT` nor a
positive `GRND_FLR` are ignored. When the join is used, the attribution line
`건물 높이: 국가공간정보포털 GIS건물통합정보 (국토교통부)` is added.

## Filling gaps in OSM building coverage

OSM building coverage in Korea is uneven: dense in central Seoul, patchy
elsewhere. In a sparsely mapped area most buildings fall back to the height
heuristic, and POIs can end up standing on empty ground. If you already pass
`--kr-buildings`, `--kr-fill-missing` reuses the same polygons as **footprint
sources**, not only as a height source:

```sh
maprama-osm build --raw raw.json --out world.json --name "Haeundae, Busan" \
  --kr-buildings kr.geojson --kr-fill-missing
```

The flag is **off by default**, so existing pipelines keep producing byte-identical
worlds. It requires `--kr-buildings`; on its own it is a usage error. The library
option is `buildWorld(raw, { krBuildings, krFillMissing: true })`, still pure and
network-free.

**What counts as "already represented by OSM".** A national-dataset polygon is
skipped as a duplicate when either side of the existing 50% / centroid rule says
OSM already has it:

1. an OSM building matched it through the normal height join — it covered ≥ 50%
   of that OSM footprint's area, or it was the smallest polygon containing that
   footprint's centroid; **or**
2. an emitted OSM footprint covers ≥ 50% of *the national polygon's own* area, or
   contains its centroid. (Direction 2 catches the cases the height join misses,
   such as one large OSM building drawn over several small national polygons, or
   the reverse.)

Both directions use `KR_MIN_OVERLAP = 0.5` and planar intersection area in world
units, so the threshold is the one already documented for heights. Polygons whose
bounds lie entirely outside the requested bbox are ignored and are not counted as
duplicates.

**Everything else follows the normal pipeline.** A generated footprint is
projected, simplified with `--simplify-meters`, clipped to the bbox, rounded to
`--precision`, cleaned of duplicate and collinear vertices, wound
counter-clockwise, and dropped when it falls below the minimum building area. It
is also compared against the footprints already emitted, so identical geometry is
never written twice.

| | Generated building |
| --- | --- |
| `id` | `k` + 16 hex characters, hashed from the source lng/lat ring rounded to 7 decimals. Cannot collide with `n`/`w`/`r`, and is stable across dataset re-exports, feature reordering and any change of `--origin`, `--unit-meters`, `--simplify-meters` or `--precision`. A hash collision inside one world gets a `_1`, `_2`, … suffix |
| `height` | `HEIGHT` m, else `GRND_FLR` × 3.2 m — the same precedence the height join uses |
| `levels` | `GRND_FLR`, when positive |
| `kind` | `classifyKind` with no OSM tags: `glass` at 60 m or taller, `office` at 20 m or taller, otherwise `brick` — the same fallback an untagged OSM building gets |
| `name` | never set |

`kind` cannot be better than that today: `KrBuildingIndex.fromGeoJson` reads only
`HEIGHT` and `GRND_FLR` from each feature, and the `ogr2ogr` export above selects
only those two columns, so no use-type attribute (`BDTYP_CD`, `MAIN_PURPS`, …)
reaches the builder. For the same reason a feature with neither a positive
`HEIGHT` nor a positive `GRND_FLR` is not indexed at all, and therefore cannot be
filled in either. In the national dataset `HEIGHT` is often `0` while `GRND_FLR`
is set, which the floor-count fallback covers.

The stats block reports `buildingsFromOsm`, `buildingsFilled` and
`krFillSkipped`; `buildings` is their sum for the OSM and filled counts. A world
that contains filled footprints carries the same
`건물 높이: 국가공간정보포털 GIS건물통합정보 (국토교통부)` attribution line — with
the flag on it covers the footprints as well as the heights, and it must not be
removed. See [Licenses and attribution](#licenses-and-attribution).

## Licenses and attribution

- **OpenStreetMap data** is © OpenStreetMap contributors and available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/).
  Any map or app that shows a world built by this tool must display
  `© OpenStreetMap contributors` (every world's `attribution[]` includes it)
  and make clear the data is available under the ODbL
  (<https://www.openstreetmap.org/copyright>). A generated world JSON is a
  *derivative database*: if you distribute it publicly, the ODbL share-alike
  terms apply to that database. **This includes
  `samples/seongsu.world.json`, which is licensed under ODbL 1.0, not under the
  repository's Apache-2.0 license.**
- **Korean national building data** is distributed under the terms shown on the
  국가공간정보포털 download page (Korean public data is typically released under
  KOGL/공공누리 terms that require source attribution — usually 제1유형, 출처표시).
  Check the terms for your download, and keep the attribution line in
  `attribution[]`. With `--kr-fill-missing` the dataset contributes geometry and
  not only attribute values, so a world built that way mixes two differently
  licensed sources: the OSM part stays ODbL, the filled footprints follow the
  dataset's own terms. If you redistribute such a world, satisfy both. We cannot
  tell you how those two interact for your case — that is a question for your own
  legal advice.
- The code in this package is Apache-2.0.

This section is a practical summary, not legal advice.
