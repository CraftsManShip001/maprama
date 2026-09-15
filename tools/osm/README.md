# @maprama/osm

Builds Maprama [`WorldData`](../../packages/protocol/src/world.ts) JSON from
OpenStreetMap data (via the Overpass API). It can optionally add building
heights from the Korean national building dataset.

- CLI: `maprama-osm` (`fetch`, `build`, `sample`)
- Library: `buildWorld(raw, options)`, a pure function you can unit-test without network access
- Sample world: [`samples/seongsu.world.json`](samples/seongsu.world.json) (Seongsu-dong, Seoul)

## Build

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
| `--precision <n>` | `2` | Decimal places of output coordinates (world units) |
| `--include-sidewalks` | off | Keep `footway=sidewalk\|crossing` ways |

The output is written one feature per line. That keeps it compact and easy to
diff in git. The CLI validates the written file with `validateWorldData` and
warns if it grows past 3 MB.

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
rings, the pieces are suffixed `_0`, `_1`, and so on.

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
  KOGL/공공누리 terms that require source attribution). Check the terms for your
  download, and keep the attribution line in `attribution[]`.
- The code in this package is Apache-2.0.

This section is a practical summary, not legal advice.
