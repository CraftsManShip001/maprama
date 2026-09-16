# 월드 데이터와 타일

엔진은 **WorldData**라는 작은 벡터 지도를 받아 건물과 도로, 물, 공원, 라벨을 만듭니다. 형식은 `@maprama/protocol`의 [`WorldData`](/api/reference/protocol/interfaces/WorldData)가 정의하고, 두 엔진이 똑같이 읽습니다.

## 월드를 넘기는 세 가지 방법

```ts
type WorldSource =
  | { kind: 'data'; world: WorldData }                          // 인라인 객체
  | { kind: 'url'; url: string }                                // 엔진이 fetch하는 JSON 주소
  | { kind: 'procedural'; layout: 'grid' | 'town'; seed?: number }; // 결정적 데모 레이아웃
```

| 방법 | 쓰는 곳 |
| --- | --- |
| `procedural` | 프로토타입, 데모, 테스트. 같은 `seed`면 같은 동네 |
| `url` | 운영. 직접 만든 JSON을 CDN에 두거나 호스팅 서비스의 `/v1/worlds/{region}.json` |
| `data` | 앱 번들에 넣은 작은 월드, 서버에서 받은 데이터를 가공한 경우 |

## 좌표계

월드 좌표는 **월드 단위**(world unit)로 저장합니다. `unitMeters`가 한 단위의 미터 수(도구 기본값 8)이고, `origin`의 경위도가 `(0, 0)`입니다.

- `+x` = 동쪽, `z` = **−북쪽** (북쪽으로 갈수록 z가 작아짐)
- 앱 API는 모두 `{ lng, lat }` 경위도를 씁니다. 엔진이 `createProjection`으로 변환합니다.

```ts
import { createProjection } from '@maprama/protocol';

const proj = createProjection({ origin: { lng: 127.0565, lat: 37.5445 }, unitMeters: 8 });
const p = proj.toWorld({ lng: 127.0571, lat: 37.5449 }); // { x, z }
```

네이티브 엔진은 같은 투영을 C++로 옮기고 1e-6 월드 단위 이내로 일치하는지 테스트합니다.

## WorldData 구조

| 필드 | 내용 |
| --- | --- |
| `version`, `name`, `origin`, `unitMeters`, `bounds` | 메타데이터와 범위 |
| `roads[]` | 도로 중심선. `cls`는 `arterial`/`local`/`alley`, `bridge`, `name` |
| `buildings[]` | 건물 윤곽(`[x, z]` 링, 양의 신발끈 면적), `height`(월드 단위), `levels`, `kind`(`glass`/`office`/`apartment`/`brick`) |
| `water[]`, `parks[]` | 폴리곤 (구멍 없음) |
| `pois[]` | 이름과 `cat`(`subway`, `cafe`, `store`, `music`, `school`, `book`, `plaza`, `park`) |
| `stations[]` | 지하철역 (지하철 이동의 승하차 지점) |
| `districts[]` | 동·하천 이름 라벨 |
| `attribution[]` | 반드시 표시해야 하는 출처 문구 |

`validateWorldData(value)`로 직접 검증할 수 있습니다.

## 내 동네 만들기

오픈소스 CLI `maprama-osm`이 Overpass API에서 OSM 데이터를 받아 WorldData로 바꿉니다.

```sh
maprama-osm fetch --bbox 37.5410,127.0520,37.5480,127.0610 --out raw.json
maprama-osm build --raw raw.json --out world.json --name "Seongsu-dong, Seoul"
```

국가공간정보포털 **GIS건물통합정보**를 GeoJSON으로 바꿔 `--kr-buildings`로 넘기면 OSM에 없는 건물 높이와 층수를 채웁니다. 매핑 규칙과 옵션은 [maprama-osm](/tools/osm)에 있어요.

### OSM에 건물 자체가 없을 때

서울 도심을 벗어나면 OSM 건물 커버리지가 듬성듬성합니다. 건물이 아예 없으면 높이를 채울 대상도 없고, POI 핀이 빈 땅에 서는 일이 생깁니다. `--kr-fill-missing`을 함께 주면 같은 국가 데이터 폴리곤을 **높이 출처이자 윤곽 출처**로 씁니다.

```sh
maprama-osm build --raw raw.json --out world.json --name "해운대, 부산" \
  --kr-buildings kr.geojson --kr-fill-missing
```

- 기본값은 **꺼짐**입니다. 플래그를 주지 않으면 결과가 지금과 완전히 같습니다. `--kr-buildings` 없이 쓰면 사용법 오류입니다.
- 중복 방지: 국가 데이터 폴리곤이 (1) 높이 조인에서 어떤 OSM 건물과 이미 매칭됐거나, (2) 어떤 OSM 윤곽이 그 폴리곤 면적의 50% 이상을 덮거나 중심점을 포함하면 건너뜁니다. 두 방향 모두 기존 높이 조인과 같은 50% / 중심점 기준입니다.
- 생성된 건물 id는 `k` + 16자리 16진수입니다. 원본 경위도 링에서 해시하므로 OSM의 `n`/`w`/`r`과 겹치지 않고, 빌드 옵션이나 피처 순서가 바뀌어도 그대로입니다.
- 높이는 `HEIGHT`(없으면 `GRND_FLR` × 3.2 m), `kind`는 태그 없는 건물과 같은 기준(60 m↑ `glass`, 20 m↑ `office`, 그 외 `brick`)입니다. 데이터에 용도 속성이 없어 이름은 붙지 않습니다.
- CLI 통계에 `buildingsFromOsm`, `buildingsFilled`, `krFillSkipped`가 찍힙니다.

자세한 규칙은 [maprama-osm의 filling gaps 절](/tools/osm)을 보세요.

::: tip 크기
CLI는 결과가 3 MB를 넘으면 경고합니다. 넓은 지역은 여러 월드로 나누거나 타일을 쓰세요.
:::

## 호스팅 서비스의 월드와 타일

| 엔드포인트 | 내용 |
| --- | --- |
| `GET /v1/worlds/{region}.json` | R2에 저장한 WorldData. `ETag`와 `If-None-Match` → 304 |
| `GET /v1/tiles/{tileset}.json` | PMTiles 아카이브 헤더로 만든 TileJSON |
| `GET /v1/tiles/{tileset}/{z}/{x}/{y}.mvt` | 벡터 타일. 비었거나 범위 밖이면 204 |

헤더를 붙일 수 없는 지도 클라이언트는 이 두 경로에서만 `?key=`를 쓸 수 있습니다. 과금 단위는 월드 요청 20, 타일 1입니다. [호스팅 서비스](/service/)를 보세요.

### 타일 기반 WorldData <span class="mpr-badge planned">계획</span>

v1 `WorldSource`에는 타일 종류가 없습니다. 넓은 지역을 위해 WorldData를 벡터 타일 레이어(`maprama_roads`, `maprama_buildings`, `maprama_water`, `maprama_parks`, `maprama_pois`, `maprama_stations`, `maprama_districts`)로 싣는 `{ kind: 'tiles', url }` 프로토콜 추가를 설계했습니다. 웹 엔진과 네이티브 엔진이 같은 릴리스에서 함께 지원할 예정입니다. 스키마는 [엔진 구조와 로드맵](./architecture#타일)에 있어요.

## 라이선스와 출처 표기

- **OSM 데이터**: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). 생성한 월드 JSON은 파생 데이터베이스이므로 공개 배포하면 ODbL 동일조건이 적용됩니다. 저장소의 성수동 샘플도 Apache-2.0이 아니라 ODbL입니다.
- **국내 건물 데이터**: 국가공간정보포털 다운로드 페이지의 이용 조건(보통 공공누리 제1유형 출처표시)을 따르고, CLI가 넣는 출처 문구를 지우지 마세요. `--kr-fill-missing`으로 만든 월드는 도형까지 이 데이터에서 왔으므로 ODbL(OSM 부분)과 데이터셋 자체 조건이 함께 걸립니다. 재배포한다면 양쪽을 모두 만족시키세요.
- 앱에서는 `ui` prop의 `attribution: true`로 `attribution[]`을 화면에 표시합니다.

이 절은 실무 요약이며 법률 자문이 아닙니다.
