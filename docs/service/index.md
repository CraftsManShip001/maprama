# 호스팅 서비스

오픈소스 SDK 옆에 있는 **유료 호스팅 서비스**입니다. 직접 운영해도 되지만 번거로운 부분을 API 키 하나로 제공합니다.

- 월드 JSON과 PMTiles 벡터 타일
- 장소 검색과 역지오코딩 (POI, 도로명주소, 역)
- 대중교통 역과 노선
- 동적 드롭 캠페인과 **서버 검증 수집**, 서명된 영수증
- 사용량 계량, 월 무료 할당량, 서명된 웹훅

Cloudflare Workers(Hono) 위에서 D1(SQLite)과 R2로 동작합니다.

## 인증

`/v1/health`를 뺀 모든 엔드포인트는 API 키가 필요합니다.

```http
Authorization: Bearer mpr_...
```

헤더를 붙일 수 없는 지도 클라이언트는 `GET /v1/worlds/*`와 `GET /v1/tiles/*`에서**만** `?key=`를 쓸 수 있습니다. 다른 곳에서 쿼리 키를 쓰면 `401 QUERY_KEY_NOT_ALLOWED`입니다.

| 역할 | 쓰는 곳 |
| --- | --- |
| `client` | 앱과 기기. 앱 번들에 들어가므로 비밀이 아닙니다 |
| `server` | 앱 백엔드 |
| `admin` | 앱 소유자. 캠페인, 웹훅, 영수증 비밀키 |

키는 `mpr_` + base64url 43자이고, 서비스는 SHA-256 해시만 저장합니다. 원문 키는 로그에 남기지 않습니다.

## 과금 단위

과금 대상 요청은 키의 UTC 월 카운터에 가중치만큼 더합니다. 상태 코드가 400 미만이거나, collect가 422(검증 작업은 수행됨)일 때 과금됩니다.

| 엔드포인트 | 권한 | 단위 (가중치) |
| --- | --- | --- |
| `GET /v1/worlds/{region}.json` | 모든 키, `?key=` 허용 | `world` (20) |
| `GET /v1/tiles/{tileset}.json` | 모든 키, `?key=` 허용 | `tile` (1) |
| `GET /v1/tiles/{tileset}/{z}/{x}/{y}.mvt` | 모든 키, `?key=` 허용 | `tile` (1) |
| `GET /v1/search?q=&near=&limit=` | 모든 키 | `search` (5) |
| `GET /v1/reverse?lng=&lat=` | 모든 키 | `search` (5) |
| `GET /v1/transit/stations?bbox=` | 모든 키 | `transit` (2) |
| `GET /v1/transit/lines/{lineId}` | 모든 키 | `transit` (2) |
| `POST /v1/drops/campaigns` | `admin`, `server` | 무료 |
| `GET /v1/drops/nearby` | 모든 키 | `drops` (2) |
| `POST /v1/drops/collect` | 모든 키 | `collect` (10) |
| `POST /v1/webhooks`, `POST /v1/webhooks/test` | `admin` | 무료 |
| `GET /v1/receipts/secret` | `admin` | 무료 |
| `GET /v1/usage` | 모든 키 | 무료 |

- **free** 플랜: `used + weight > monthlyQuota`가 되면 `429 QUOTA_EXCEEDED`
- **pro** 플랜: 계속 동작하고 초과분은 `overageUnits`로 기록되어 사용량 과금
- 응답 헤더: `X-Maprama-Usage: used/quota`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`

## 오류 형식

```json
{ "error": { "code": "TOO_FAR", "message": "..." } }
```

`code`는 안정적인 값입니다. 전체 목록은 [OpenAPI 레퍼런스](./api-reference)의 `ErrorCode` 스키마에 있어요.

## 보안 모델 요약

- `client` 키는 앱 번들에 들어가므로 비밀이 아닙니다. 캠페인, 웹훅, 영수증 비밀키는 `admin` 키로만 다룹니다.
- **서비스는 `POST /v1/drops/collect`의 `userId`를 인증하지 않습니다.** 영수증은 그 `userId`로 드롭·위치·시간이 검증되었다는 증명일 뿐입니다. 앱 서버가 `claims.userId`를 자기 인증 사용자와 대조해야 합니다.
- 순간이동 판정은 서버 검증 시각만 씁니다.
- 웹훅 URL은 공개 https 호스트 이름만 허용합니다.
- 계획된 후속 작업: collect를 `server` 키로만 허용하는 서버 경유 방식, 또는 앱 서버가 발급한 서명 사용자 토큰.

자세한 내용은 [웹훅과 영수증 검증의 보안 모델](./webhooks-receipts#보안-모델)에 있어요.

## 검색

- 이름과 주소를 NFKC 정규화하고 공백·문장부호를 뺀 뒤 글자 bigram으로 색인합니다 (D1은 FTS5).
- 순위: 이름 일치 1.0, 이름 접두 0.9, 이름 부분 0.8, 주소 부분 0.75, 나머지는 bigram 겹침 × 0.7. `near`가 있으면 `0.7·텍스트 + 0.3·1/(1 + 거리/1 km)`.
- `/v1/reverse`는 200 m 안의 가장 가까운 주소를 돌려줍니다.
- 주소 데이터는 도로명주소 DB를 `scripts/import-addresses.ts`로 가져옵니다.

## 로컬에서 돌려 보기

Cloudflare 계정 없이도 전부 로컬에서 테스트할 수 있습니다.

```sh
npm run build -w @maprama/protocol
cd services/api
npm run dev:local -- --port 8787 --world seongsu=../../tools/osm/samples/seongsu.world.json
curl -H "Authorization: Bearer $KEY" 'http://localhost:8787/v1/search?q=성수역'
```

`dev:local`은 메모리 저장소로 뜨고 개발용 client 키와 admin 키를 출력합니다.

## 다음

- [OpenAPI 레퍼런스](./api-reference)
- [웹훅과 영수증 검증](./webhooks-receipts)
- [드롭과 서버 검증 가이드](/guide/drops)
