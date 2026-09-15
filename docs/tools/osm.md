# maprama-osm (월드 빌드)

OpenStreetMap 데이터를 Overpass API로 받아 Maprama [`WorldData`](/api/reference/protocol/interfaces/WorldData) JSON으로 바꿉니다. 선택적으로 국내 GIS건물통합정보의 건물 높이를 붙입니다.

- CLI: `maprama-osm` (`fetch`, `build`, `sample`)
- 라이브러리: `buildWorld(raw, options)`. 네트워크 없이 단위 테스트할 수 있는 순수 함수
- 샘플: `tools/osm/samples/seongsu.world.json` (서울 성수동, ODbL 1.0). [플레이그라운드](/playground/)에서 "성수동 (OSM)"으로 볼 수 있어요

## 사용법

```sh
# 1. bbox의 OSM 원본 받기 (south,west,north,east)
maprama-osm fetch --bbox 37.5410,127.0520,37.5480,127.0610 --out raw.json

# 2. WorldData로 변환
maprama-osm build --raw raw.json --out world.json --name "Seongsu-dong, Seoul"

# 내장 샘플 지역을 한 번에
maprama-osm sample seongsu
```

### `fetch`

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--bbox s,w,n,e` | 필수 | 경위도 범위 |
| `--out <file>` | 필수 | Overpass 원본 JSON (bbox를 담은 `maprama` 메타데이터 포함) |
| `--endpoint <url>` | 아래 참고 | 반복 가능. 순서대로 시도 |
| `--timeout <s>` | `90` | 요청당 타임아웃 |
| `--no-cache` | | 응답 캐시 건너뛰기 |

### `build`

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--raw <file>` | 필수 | `fetch` 결과 (Overpass `[out:json]` + `out geom`이면 무엇이든) |
| `--out <file>` | 필수 | WorldData JSON |
| `--name <name>` | 필수 | 월드 이름 |
| `--bbox s,w,n,e` | `raw.maprama.bbox`, 없으면 데이터 범위 | 자르기 범위 |
| `--origin lat,lng` | bbox 중심 | 월드 `(0, 0)`이 될 지점 |
| `--unit-meters <m>` | `8` | 월드 단위당 미터 |
| `--simplify-meters <m>` | `0.5` | Douglas–Peucker 허용 오차 |
| `--kr-buildings <file>` | | 국내 건물 GeoJSON |
| `--precision <n>` | `2` | 좌표 소수 자릿수 (월드 단위) |
| `--include-sidewalks` | 끔 | `footway=sidewalk\|crossing` 유지 |

출력은 한 줄에 피처 하나씩 써서 작고 git diff가 읽기 쉽습니다. CLI는 `validateWorldData`로 결과를 검증하고 3 MB를 넘으면 경고합니다.

### Overpass 엔드포인트

기본 순서는 `overpass-api.de` → `maps.mail.ru` → `overpass.private.coffee`이고, 목록을 두 바퀴 돌며 지수 백오프합니다. 429/5xx, JSON이 아닌 응답, Overpass `remark` 런타임 오류는 재시도하고, 400(잘못된 쿼리)은 재시도하지 않습니다.

- `MAPRAMA_OVERPASS_ENDPOINT`: 쉼표로 구분한 목록으로 기본값 대체
- `MAPRAMA_OSM_USER_AGENT`: User-Agent 대체 (Overpass는 User-Agent가 없으면 406)
- 응답은 `tools/osm/.cache/`에 캐시됩니다. [Overpass 사용 정책](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)을 지켜 bbox를 작게 유지하세요.

## 매핑 규칙

좌표는 `+x` = 동, `z` = −북, 단위는 `unitMeters`입니다. id는 `w<wayId>`, `r<relationId>`, `n<nodeId>`이고, bbox에서 잘리거나 외곽 링이 여러 개면 `_0`, `_1`이 붙습니다.

### 도로

| OSM | `cls` |
| --- | --- |
| `motorway`, `trunk`, `primary`, `secondary` (+ `_link`) | `arterial` |
| `tertiary`, `residential`, `unclassified`, `living_street`, 이름 있는 `service` | `local` |
| `footway`, `path`, `pedestrian`, `service`, `track`, `steps`, `cycleway` | `alley` |
| `construction`, `proposed`, `platform`, `area=yes`, `indoor=yes`, … | 제외 |

`bridge=*`(`no` 제외)는 `bridge: true`. 이름은 `name:ko`, 없으면 `name`.

### 건물 높이 우선순위

1. 국내 데이터 `HEIGHT` (m)
2. 국내 데이터 `GRND_FLR` × 3.2 m
3. `height` 태그
4. `building:levels` × 3.2 m
5. `building=*` 추정: `apartments` 45 m, `commercial`/`office` 30 m, `house`/`residential` 9 m, `retail` 7 m, 나머지 12 m

### 외벽 종류

- `glass`: 60 m 이상 또는 유리 재질 태그
- `apartment`: 20 m 이상의 `apartments`/`residential`
- `office`: 상업, 업무, 공공 건물
- `brick`: 작은 건물, 1990년 이전(`start_date`), `retail`, 주택

### POI

| OSM | `cat` |
| --- | --- |
| `railway=station`, `station=subway` | `subway` (`stations[]`에도) |
| `shop=music`, 또는 이름에 `LP`·`레코드`·`음반`이 들어간 가게 | `music` |
| `amenity=cafe` | `cafe` |
| `shop=convenience\|supermarket` | `store` |
| `amenity=school\|kindergarten` | `school` |
| `shop=books` | `book` |
| `leisure=park` | `park` |
| `place=square` | `plaza` |

500 m 안의 같은 이름 역 노드는 하나로 합칩니다. 동 라벨은 `place=neighbourhood|quarter|suburb`, 물은 `natural=water`·`waterway=riverbank`·`water=river`(멀티폴리곤으로 한강 같은 큰 강 포함), 공원은 `leisure=park|garden`·`landuse=grass|recreation_ground`입니다.

### 한계

- WorldData 폴리곤에는 구멍이 없어서 안쪽 링(중정, 섬)은 버려집니다.
- 오목한 폴리곤을 bbox로 자르면 경계에 폭 0인 변이 남을 수 있습니다.
- 역은 bbox 안의 것만 가져옵니다.

## 국내 건물 높이 (선택)

국가공간정보포털(<https://www.nsdi.go.kr>)의 **GIS건물통합정보**는 `GRND_FLR`(지상 층수)와 `HEIGHT`(m)를 담은 건물 윤곽을 지역별 SHP로 배포합니다. WGS84 GeoJSON으로 바꿔 넘기세요.

```sh
# 원본 좌표계는 보통 EPSG:5186, 일부는 EPSG:5179(UTM-K). .prj를 확인하세요.
ogr2ogr -f GeoJSON kr.geojson AL_D010_11_YYYYMMDD.shp \
  --config SHAPE_ENCODING CP949 \
  -s_srs EPSG:5186 -t_srs EPSG:4326 \
  -spat 127.052 37.541 127.061 37.548 -spat_srs EPSG:4326 \
  -select GRND_FLR,HEIGHT \
  -lco RFC7946=YES

maprama-osm build --raw raw.json --out world.json --name "Seongsu-dong, Seoul" --kr-buildings kr.geojson
```

결합 규칙: OSM 윤곽 면적의 50% 이상을 덮는 국내 폴리곤 중 가장 많이 겹치는 것을 쓰고, 없으면 윤곽 중심을 포함하는 가장 작은 폴리곤을 씁니다. 결합하면 `건물 높이: 국가공간정보포털 GIS건물통합정보 (국토교통부)` 출처 문구가 `attribution[]`에 추가됩니다.

## 라이선스

- OSM 데이터는 © OpenStreetMap contributors, ODbL 1.0입니다. 생성한 월드는 파생 데이터베이스이며 공개 배포하면 동일조건이 적용됩니다. **`samples/seongsu.world.json`도 Apache-2.0이 아니라 ODbL입니다.**
- 국내 건물 데이터는 다운로드 페이지의 이용 조건(보통 공공누리 출처표시)을 따르세요.
- 도구의 코드는 Apache-2.0입니다.

이 절은 실무 요약이며 법률 자문이 아닙니다.
