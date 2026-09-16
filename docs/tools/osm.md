# maprama-osm (월드 빌드)

OpenStreetMap 데이터를 Overpass API로 받아 Maprama [`WorldData`](/api/reference/protocol/interfaces/WorldData) JSON으로 바꿉니다. 선택적으로 국내 GIS건물통합정보의 건물 높이를 붙이고, OSM에 건물이 아예 없는 곳은 건물 자체를 채울 수 있습니다.

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
| `--kr-fill-missing` | 끔 | OSM에 없는 국내 데이터 폴리곤도 건물로 내보내기 ([빈 곳 채우기](#osm에-건물이-없는-곳-채우기)). `--kr-buildings` 필요 |
| `--precision <n>` | `2` | 좌표 소수 자릿수 (월드 단위) |
| `--include-sidewalks` | 끔 | `footway=sidewalk\|crossing` 유지 |

출력은 한 줄에 피처 하나씩 써서 작고 git diff가 읽기 쉽습니다. CLI는 `validateWorldData`로 결과를 검증하고 3 MB를 넘으면 경고합니다.

CLI는 표준 출력에 통계 JSON을 찍습니다. 레이어별 개수 외에 `buildingsFromOsm`, `buildingsFilled`(국내 데이터에서 생성), `krFillSkipped`(OSM에 이미 있어 건너뛴 국내 폴리곤), `krIndexed`, `krMatches`가 들어 있습니다.

### Overpass 엔드포인트

기본 순서는 `overpass-api.de` → `maps.mail.ru` → `overpass.private.coffee`이고, 목록을 두 바퀴 돌며 지수 백오프합니다. 429/5xx, JSON이 아닌 응답, Overpass `remark` 런타임 오류는 재시도하고, 400(잘못된 쿼리)은 재시도하지 않습니다.

- `MAPRAMA_OVERPASS_ENDPOINT`: 쉼표로 구분한 목록으로 기본값 대체
- `MAPRAMA_OSM_USER_AGENT`: User-Agent 대체 (Overpass는 User-Agent가 없으면 406)
- 응답은 `tools/osm/.cache/`에 캐시됩니다. [Overpass 사용 정책](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)을 지켜 bbox를 작게 유지하세요.

## 매핑 규칙

좌표는 `+x` = 동, `z` = −북, 단위는 `unitMeters`입니다. id는 `w<wayId>`, `r<relationId>`, `n<nodeId>`이고, bbox에서 잘리거나 외곽 링이 여러 개면 `_0`, `_1`이 붙습니다. 국내 데이터에서 만든 건물은 네 번째 접두사 `k`를 씁니다([빈 곳 채우기](#osm에-건물이-없는-곳-채우기)).

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

결합 규칙: OSM 윤곽 면적의 50% 이상을 덮는 국내 폴리곤 중 가장 많이 겹치는 것을 쓰고, 없으면 윤곽 중심을 포함하는 가장 작은 폴리곤을 씁니다. 속성 이름은 대소문자를 구분하지 않고, `HEIGHT`와 `GRND_FLR`이 모두 없거나 0 이하인 피처는 무시합니다. 결합하면 `건물 높이: 국가공간정보포털 GIS건물통합정보 (국토교통부)` 출처 문구가 `attribution[]`에 추가됩니다.

## OSM에 건물이 없는 곳 채우기

서울 도심 밖에서는 OSM 건물 커버리지가 듬성듬성합니다. 건물이 아예 없으면 높이를 붙일 대상도 없고, POI 핀이 빈 땅에 서기도 합니다. `--kr-buildings`를 이미 쓰고 있다면 `--kr-fill-missing`이 같은 폴리곤을 **윤곽 출처**로도 씁니다.

```sh
maprama-osm build --raw raw.json --out world.json --name "해운대, 부산" \
  --kr-buildings kr.geojson --kr-fill-missing
```

기본값은 **꺼짐**이라 기존 파이프라인 결과는 그대로입니다. `--kr-buildings` 없이 쓰면 사용법 오류입니다. 라이브러리에서는 `buildWorld(raw, { krBuildings, krFillMissing: true })`이고, 여전히 네트워크를 쓰지 않는 순수 함수입니다.

**중복 판정.** 국내 폴리곤은 다음 중 하나면 "OSM에 이미 있다"고 보고 건너뜁니다. 둘 다 높이 조인과 같은 `KR_MIN_OVERLAP = 0.5` 기준입니다.

1. 높이 조인에서 어떤 OSM 건물과 매칭됐다 — 그 OSM 윤곽 면적의 50% 이상을 덮었거나, 그 윤곽의 중심점을 포함하는 가장 작은 폴리곤이었다.
2. 내보낸 어떤 OSM 윤곽이 *국내 폴리곤 자신의* 면적을 50% 이상 덮거나 그 중심점을 포함한다. (큰 OSM 건물 하나가 작은 국내 폴리곤 여러 개를 덮는 경우처럼 1번이 놓치는 상황을 잡습니다.)

bbox 밖에 완전히 벗어난 폴리곤은 무시하며, 중복으로 세지 않습니다.

**나머지는 기존 파이프라인 그대로입니다.** 생성된 윤곽도 투영 → `--simplify-meters` 단순화 → bbox 자르기 → `--precision` 반올림 → 중복·공선점 제거 → 반시계 방향 정리를 거치고, 최소 면적 미만이면 버려집니다. 이미 내보낸 윤곽과 좌표가 같으면 다시 쓰지 않습니다.

| | 생성된 건물 |
| --- | --- |
| `id` | `k` + 16자리 16진수. 원본 경위도 링(소수점 7자리 반올림)을 해시하므로 `n`/`w`/`r`과 겹치지 않고, 데이터 재추출·피처 순서·`--origin`/`--unit-meters`/`--simplify-meters`/`--precision` 변경에도 그대로입니다. 한 월드 안에서 해시가 충돌하면 `_1`, `_2`가 붙습니다 |
| `height` | `HEIGHT` m, 없으면 `GRND_FLR` × 3.2 m (높이 조인과 같은 우선순위) |
| `levels` | `GRND_FLR`이 양수일 때 |
| `kind` | OSM 태그가 없는 건물과 같은 기준: 60 m↑ `glass`, 20 m↑ `office`, 그 외 `brick` |
| `name` | 붙지 않음 |

`kind`를 더 잘 정할 수는 없습니다. `KrBuildingIndex.fromGeoJson`은 피처에서 `HEIGHT`와 `GRND_FLR`만 읽고, 위 `ogr2ogr` 예시도 그 두 컬럼만 선택하므로 용도 속성(`BDTYP_CD`, `MAIN_PURPS` 등)이 빌더까지 오지 않습니다. 같은 이유로 `HEIGHT`도 `GRND_FLR`도 양수가 아닌 피처는 색인되지 않아 채우기 대상도 되지 않습니다. 실제 데이터에서는 `HEIGHT`가 0이고 `GRND_FLR`만 있는 경우가 많은데, 그건 층수 대체 규칙이 덮습니다.

통계에는 `buildingsFromOsm`, `buildingsFilled`, `krFillSkipped`가 나오고, `buildings`는 앞의 두 값을 합한 수입니다. 채워 넣은 윤곽이 있는 월드도 같은 `건물 높이: 국가공간정보포털 GIS건물통합정보 (국토교통부)` 문구를 그대로 달고 나옵니다. 이때 그 문구는 높이뿐 아니라 윤곽의 출처이기도 하니 지우지 마세요.

## 라이선스

- OSM 데이터는 © OpenStreetMap contributors, ODbL 1.0입니다. 생성한 월드는 파생 데이터베이스이며 공개 배포하면 동일조건이 적용됩니다. **`samples/seongsu.world.json`도 Apache-2.0이 아니라 ODbL입니다.**
- 국내 건물 데이터는 다운로드 페이지의 이용 조건(보통 공공누리 제1유형 출처표시)을 따르세요. `--kr-fill-missing`으로 만든 월드는 도형까지 이 데이터에서 왔으므로 OSM 부분의 ODbL과 데이터셋 자체 조건이 함께 걸립니다. 재배포한다면 양쪽을 모두 만족시켜야 하고, 두 조건이 구체적으로 어떻게 맞물리는지는 직접 법률 자문을 받으세요.
- 도구의 코드는 Apache-2.0입니다.

이 절은 실무 요약이며 법률 자문이 아닙니다.
