# Korean nationwide data sources

Which datasets a nationwide Korean `WorldData` build can legally use, what they actually contain, and
what is still unverified. Researched 2026-09-18 against primary sources. **Licences and terms change —
re-check every URL before a commercial launch, and take your own legal advice. This file is notes, not
advice.**

Companion documents: [`tile-format.md`](./tile-format.md) (how the data is packed for streaming),
[`../tools/osm/README.md`](../tools/osm/README.md) (the OSM path that exists today).

## Why this file exists

`maprama-osm` builds worlds from OpenStreetMap, which is fine for one neighbourhood and has two
problems at national scale:

1. **Heights.** In Korea roughly **77 % of OSM building heights are guesses** the builder derives, and
   in a small city there is essentially nothing: 남원시 has 477 building ways, **one** of which carries
   `building:levels` or `height`.
2. **ODbL share-alike.** A generated world is a derivative database. Distributing it publicly — which is
   what hosting tiles is — pulls in share-alike. Korean public data mostly does not.

Both are solved by the same move: take the geometry and the heights from Korean public data.

## The verdict on commercial providers

All of them were checked and all of them are unusable for this, not because of price but because of
terms. Recorded so nobody re-opens the question.

| Provider | Why not |
| --- | --- |
| **Mapbox** | Product Terms §1.6 forbids deriving or extracting content; §1.9 forbids bulk queries and any `export, download, cache or store`; §2.8.1 caps caching at 30 days on the end user's own device, populated by that device — so no pre-bundling; §2.9.1 makes their mobile SDK the exclusive access path, which rules out a custom renderer; §1.5(iv) bars building anything that competes with a Mapbox product. |
| **Google Photorealistic 3D Tiles** | The Map Tiles API policy names `Geodata extraction` and `Offline uses` as prohibited. ToS §3.2.3(c) gives "digitize building outlines" and "create 3D building models" as banned examples. And the payload is textured glTF mesh — no per-building footprint or height to extract anyway. |
| **MapTiler** | Cloud Terms §7 forbids tracing/deriving/extracting and server-side caching; §6 forbids export and bulk download. Derivative vector datasets are permitted only for non-commercial use or for OSM. On-prem Standard is capped at a single internal app and 500 MAU. |
| **Kakao** | The operating policy lists **게임 애플리케이션 as a prohibited category** outright. |
| **Naver Cloud Maps** | §7⑪: a result may be used once on return; storing it or building a database from it is "엄격히 금지". |

Free OSM redistributions (**Protomaps** PMTiles, **Overture** Parquet, self-run **OpenMapTiles**) are
legally fine, but they carry OSM's heights, so they do not fix problem 1 — measured: Overture's Seoul
buildings have `height` on **8.0 %** and `num_floors` on **11.2 %** of 27,455 features. They replace
collection infrastructure, which `maprama-osm --pbf` already does.

One Overture theme is worth knowing about: **`places` is CDLA-Permissive-2.0 + Apache-2.0 and carries
no share-alike**, so it is an ODbL-free POI option. Keep licences in separate archives if you ever mix
them — merging an ODbL layer into one database with permissive layers can pull the whole thing under
ODbL.

## Sources to build from

Everything below allows commercial use *and* derivative works. Attribution is required in all cases and
the engine already draws `WorldData.attribution`.

| `WorldData` field | Dataset | Licence | Verified |
| --- | --- | --- | --- |
| `buildings[]` + `height` | 국토교통부 **GIS건물통합정보** ([data.go.kr 15083092](https://www.data.go.kr/data/15083092/fileData.do), vworld `dsId=18`) — 14,422,486 buildings, SHP, EPSG:5186, monthly full + daily diffs | CC BY / 공공누리 제1유형 | heights measured, see below |
| `roads[]` | 연속수치지형도 도로중심선 (`rddv` 등급, `rdln` 차로수, `rvwd` 도로폭) | 제1유형 | fields confirmed, file not opened |
| `parks[]` | 토지이음 **(도시계획)시설정보** ([data.go.kr 15047835](https://www.data.go.kr/data/15047835/fileData.do)) layer `*_C_UQ153` | 공공누리 제1유형 | **yes — opened and counted** |
| `water[]` | 연속수치지형도 실폭하천 / 하천경계 / 호소 (vworld dtmk `dsId=30207`, `30248`, `30256`) | CC BY | **no — blocked, see below** |
| `pois[]` | 소상공인시장진흥공단 **상가(상권)정보** (~2 M businesses, quarterly) | 이용허락범위 제한 없음 | not opened |
| `stations[]` | 전국도시철도역사정보표준데이터 (1,073) + 국가철도공단 철도역 (215) | 제한 없음 | not opened |
| `districts[]` | 국가데이터처 **SGIS 행정구역 경계** | 제한 없음 | not opened |

### Traps

These are all one wrong click away from the right dataset.

- **The same source has different licences down different paths.** UPIS 도시계획 data is 공공누리 **제4유형**
  (no commercial use, no modification) through the `국토교통부_도시계획정보_*` datasets, and **제1유형**
  through 토지이음 / 15047835. The path decides.
- **`건물통합정보_마스터` ([15146873](https://www.data.go.kr/data/15146873/fileData.do)) is 제4유형** and sits
  next to the usable `15083092` under a nearly identical name.
- **`(연속주제)_자연공원` is CC BY-NC-ND.** Not usable.
- **국토교통부 (센서스경계) 행정동경계 is 제4유형**, despite being the boundary file everyone reaches for.
- **vworld rows reading "라이센스가 지정되어 있지 않습니다"** are unspecified, which is not permission.
- **The V-World open API and the V-World download (dtmk) are different things.** The API's terms bar
  commercial use without consent (§13①4), altering (§19④) and storing (§19⑥); the dtmk downloads carry
  their own per-dataset licence. Only the downloads are usable here.
- **3D building models and the 실측 건물높이 DB are 공개제한 공간정보**: a 민간 기업 needs a 보안심사, and
  what comes back is encrypted with handling obligations. Not viable for a commercial SDK. The
  건축물대장-derived heights below are ordinary open data — that asymmetry is the whole opportunity.

## Building heights: what the data actually has

Counted, not estimated, over 26,739 buildings through the public WFS (`lt_c_bldginfo`).

| | Seoul (n=7,120) | Jeonnam (n=19,619) |
| --- | ---: | ---: |
| `height > 0` | **32.0 %** | **11.7 %** |
| `grnd_flr > 0` | 78.4 % | 66.6 % |
| either | **78.4 %** | **66.6 %** |
| **neither** | **21.6 %** | **33.4 %** |

The cause is not a missing column, it is unmatched geometry: **34.7 % of Seoul rows and 64.4 % of
Jeonnam rows carry no 건축물대장 attributes at all, and 0 % of those have a height.** Footprint without
paperwork.

So a build needs three tiers, and the third one is visible to users:

1. `height` when present.
2. `grnd_flr × storey height` otherwise. The implied storey height in the data itself is **3.34 m
   (Seoul) / 3.98 m (Jeonnam)** — median `height / grnd_flr` — so a 3.3–4.0 m constant matches reality.
3. Neither: a default. **One in five buildings in Seoul and one in three in Jeonnam land here.** Say so
   in the docs rather than letting integrators discover a city of one-storey boxes.

Values themselves are clean — Seoul median 11.2 m, p95 49.5 m, max 150.2 m; no 0.1 m or 9999 m junk.

**Caveat:** these came from the V-World 2D cache WFS, not the bulk SHP, so the snapshot may lag. The
SHP's DBF columns are anonymised `A0…An` and need the column-definition workbook: **`A16` = 높이(m),
`A26` = 지상층_수, `A27` = 지하층_수, `A24` = 건물명, `A1` = GIS건물통합식별번호**. The daily-diff file
(`CH_D010`) shifts by one from `A23` onward.

## Parks: verified

`eum_facility.zip` (475 MB, 2026-08 edition) downloads **without a login**. Inside are 18 nested
per-province zips; layer `*_C_UQ153` (공간시설) holds **78,406 ESRI POLYGONs**, of which **70,507** carry a
leaf classification, across **all 17 시도**.

| Leaf code | Meaning | Count |
| --- | --- | ---: |
| `UQT3xx` | 녹지 | 29,449 |
| `UQT2xx` | 공원 | 28,509 |
| `UQT5xx` | 공공공지 | 6,821 |
| `UQT1xx` | 광장 | 5,198 |
| `UQT4xx` | 유원지 | 530 |

Conversion notes learned by opening it:

- Read the leaf code as the **last non-empty** of `LCLAS_CL` / `MLSFC_CL` / `SCLAS_CL` — rows are
  inconsistently shifted by one column.
- 7,827 further `UQ153` rows have no classification but do have sensible names (`완충녹지`), so a
  name-based pass can recover them.
- ~10 % are multipart; split them. Vertex counts run to 54,509, median 22.
- Duplicates exist (서울숲공원 appears twice) — dedup on name + rounded area + first vertex.
- `DGM_NM` is the name (70,132 of 70,507 have one); `DGM_AR` the area, median 1,967 m².
- **EPSG:5174**, confirmed by reprojecting 남산공원 / 서울숲공원 / 여의도근린공원 to their true positions.
- Licence text on the page: "데이터는 공공누리 출처표시 조건에 따라 자유이용이 가능합니다."

**Open question:** the 토지이음 site-wide copyright notice also says "내용을 변경하지 않아야 합니다", which
contradicts 제1유형. Worth a written confirmation to 국토교통부 before a commercial launch. The
conversion below *does* modify the data (reprojects it, splits multiparts, drops holes and slivers),
so this question is live, not academic.

### Wired up: `maprama-tiles --kr-parks`

```sh
maprama-tiles kr-parks --src <dir of unpacked per-province dirs> --out kr-parks.json
maprama-tiles build --pbf korea.osm.pbf --work .work --out korea.pmtiles --kr-parks kr-parks.json
```

`tools/tiles/src/kr-parks.ts` reads the shapefiles directly (`src/shapefile.ts`, CP949 via
`TextDecoder('euc-kr')`) and does the datum shift in-process (`src/kr-proj.ts`, pinned to PROJ's
own numbers to under a millimetre), so no GDAL and no new npm dependency. Conversion of all 18
provinces takes about 4 seconds.

**Which groups are drawn as parks: `UQT2` 공원 and `UQT4` 유원지, and that is the default.** 녹지
(`UQT3`) and 공공공지 (`UQT5`) are available via `--groups` but are off, because they are legal
designations rather than places: 완충녹지 is the strip of planting a road is required to have.
Shot side by side at 서울 노원 and 은평, including them scatters small green flecks along every
street without adding anywhere a player could go — 82,311 polygons instead of 32,148 for 1,060 km²
instead of 835 km², nearly all of the extra being roadside slivers. 광장 (`UQT1`) is excluded for a
different reason: a 광장 is paved, and painting it green would be simply wrong.

**Minimum area 200 m² (≈ a 14 m square).** It drops 5,866 of 38,143 rings but only 0.4 km² of
835.6 km² — 15 % of the count, 0.05 % of the area. The distribution's first percentile is 3 m²:
these are slivers left by parcel edits and multipart decomposition, not parks.

**Blank classifications are rescued by name** (`--no-rescue` to turn it off): 2,227 of the 7,827
uncoded rows have a `DGM_NM` naming a chosen group, and they are real parks.

What it buys, measured on two regional archives at z15:

| | OSM parks | KR parks |
| --- | ---: | ---: |
| 서울 (126.80–127.18, 37.42–37.70) | 8,022 pieces / 61.3 km² | 6,901 pieces / **146.2 km²** |
| 대전 (127.28–127.52, 36.24–36.42) | 2,647 pieces / 8.7 km² | 983 pieces / **19.9 km²** |

The area roughly doubles because 도시자연공원 — 남산, 관악산, 북한산 — is a planning designation that
OSM largely does not carry as a park polygon. In the 남산 shot OSM renders bare ground where the KR
build renders the mountain park.

**The cost is names.** OSM has 1,666 distinct park names in the Seoul box; the KR data has 937, and
its commonest are the category words themselves (`근린공원` 1,567 times, `공원` 875, `어린이공원` 646).
In 대전 it is starker: 253 distinct OSM names against 45. `DGM_NM` is the facility *type* far more
often than the park's name, so label quality goes backwards where park geometry goes forwards. A
future build probably wants KR geometry with OSM names joined onto it.

## Water: blocked

Not verified, and it is the one thing standing between this project and an ODbL-free build.

The V-World dtmk download needs a login. `listFnc.download()` opens with
`if(menuFnc.loginYn == "N")`, and the server agrees: `downloadResourceFile.do` returns 200 with
`content-length: 0`, `downloadResourceFile2.do` redirects to the main page. `nsdi.go.kr` is NXDOMAIN,
the data.go.kr 연속수치지형도 entry links back to 국토정보플랫폼 (login), and data.go.kr file downloads sit
behind a CAPTCHA. **Geometry type, feature count and fields of 실폭하천 / 하천경계 / 호소 are therefore all
unknown** — including whether 실폭하천 is polygon or line, which decides whether it is usable at all.

Unblocking it is one manual action: log into V-World once and save `dsId=30207` (218 MB), `30248`
(165 MB) and `30256` (109 MB).

A partial fallback is already in hand: the park file's `UQ156` 방재시설 layer holds **10,276 river and
reservoir polygons**, but only the stretches a 도시계획 designates — no rural rivers, no sea, no large
lakes. Until water is resolved, water comes from OSM and the build stays ODbL.
