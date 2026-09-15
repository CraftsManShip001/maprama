# 드롭과 서버 검증

드롭은 지도 좌표에 떨어뜨리는 수집 아이템입니다. **앱은 무엇을 어디에 둘지 정하고, SDK는 등장 연출과 반경 판정을 맡고, 보상은 서버가 검증합니다.**

## 앱 데이터로 드롭 놓기

```tsx
<DropLayer
  id="music"
  data={tracks}
  getId={(t) => t.id}
  getCoordinate={(t) => t.coord}
  getType={() => 'cd'}
  getRarity={(t) => t.rarity}
  getValue={(t) => t.points}
  getPayload={(t) => ({ trackId: t.id })}
  collectRadiusMeters={15}
  onCollect={(e) => showSparkle(e.payload)}
/>
```

| 항목 | 값 |
| --- | --- |
| 종류 (`DROP_TYPES`) | `coin`(기본), `cd`, `vinyl`, `note`, `model` (`model`은 `getModel` 필수) |
| 희귀도 (`RARITIES`) | `common`(하늘색), `rare`(보라), `legendary`(금색). `rare`와 `legendary`에는 희귀도 색의 빛기둥과 바닥 빛 고리가 붙고, `legendary` 빛기둥은 1.5배 높습니다 |
| `collectRadiusMeters` | 수집자가 이 거리 안에 들어오면 수집. 기본 15 |
| `collectorIds` | 수집할 수 있는 캐릭터. 기본은 `isPlayer` 캐릭터, `[]`면 아무도 수집할 수 없음 |
| `payload` | 수집 이벤트에 그대로 돌아오는 JSON |

`onCollect`에는 `layerId`, `dropId`, `characterId`, `coordinate`, **`collectId`**(서버 검증용 nonce), `payload`가 옵니다.

### 기기의 수집 판정

- 수집자와 드롭의 지면 거리가 `collectRadiusMeters` 이하이면 수집됩니다.
- 수집마다 암호학적 난수로 새 `collectId`를 만듭니다.
- **드롭은 수집자마다 한 번만** 수집됩니다. 수집된 드롭은 사라지고, 그 id가 레이어에 계속 포함된 채로 다시 보내지면 보이더라도 같은 수집자는 다시 수집할 수 없습니다. 앱이 id를 레이어에서 뺐다가 다시 추가하면(서버가 일시적인 이유로 거절한 드롭을 `DropLayer`가 복원할 때처럼) 수집 기록이 초기화되어 다시 수집할 수 있습니다.
- 월드가 로드되기 전에 보낸 레이어는 로드 후 적용됩니다.

::: danger 기기 판정은 힌트일 뿐
`onCollect`는 기기가 판정한 결과입니다. 수정된 클라이언트는 얼마든지 이 이벤트를 만들 수 있으니, 보상은 반드시 서버에서 검증한 뒤 지급하세요.
:::

## 호스팅 서비스 드롭 (`source="service"`)

```tsx
<DropLayer
  id="coins"
  source="service"
  channel="coins"
  apiKey={CLIENT_KEY}
  baseUrl="https://api.example"
  userId={user.id}
  onCollect={(e) => showSparkle(e)}
  onCollectVerified={(e) => grant(e.receipt)}
  onCollectRejected={(e) => warn(e.code)}
/>
```

| prop | 필수 | 설명 |
| --- | --- | --- |
| `channel` | ✓ | 캠페인 채널 |
| `apiKey` | ✓ | 클라이언트 API 키. `Authorization: Bearer`로 보냅니다 |
| `baseUrl` | ✓ | 서비스 주소. 예: `https://api.example` |
| `userId` | ✓ | 수집 검증에 함께 보내는 앱 사용자 id |
| `radiusMeters` | | 검색 반경 (1–3000). 기본 500 |
| `refetchDistanceMeters` | | 마지막으로 받아 온 지점에서 이만큼 움직이면 다시 받음. 기본 150 |
| `characterId` | | 위치를 기준으로 삼을 캐릭터. 기본은 `isPlayer` 캐릭터 |
| `positionThrottleMs` | | 받아 오기를 결정하는 위치 구독의 간격. 기본 1000 |
| `onCollectVerified`, `onCollectRejected` | | 서비스 검증 결과 |

### 받아 오기

1. 추적 캐릭터 주변을 `GET {baseUrl}/v1/drops/nearby?lng&lat&radius&channel`로 받아 옵니다. `refetchDistanceMeters` 이상 움직이거나 응답의 `expiresAt` 창이 끝나면 다시 받습니다.
2. 응답의 `expiresAt`이 이미 지났다면(기기 시계가 어긋난 경우) 다음 받아 오기를 최소 2초 뒤로 미룹니다. 곧바로 반복 요청하지 않게 하려는 장치입니다.
3. 위치가 바뀌어도 진행 중인 요청, 창 만료 타이머, 대기 중인 재시도는 취소되지 않습니다. 이것들을 초기화하는 것은 언마운트와 `baseUrl`, `apiKey`, `channel`, `radiusMeters`, `userId` 변경뿐입니다.
4. 이 설정이 바뀌면 레이어의 드롭과 수집으로 숨긴 드롭도 비워서, 이전 채널의 상태가 새 채널로 넘어가지 않습니다.
5. 응답은 요청 순서대로 적용됩니다. 이미 적용한 응답보다 오래된 응답은 버립니다.

### 받아 오기 실패

실패는 `onError`로 `drops_fetch_failed` 코드와 함께 옵니다.

| 분류 | 경우 | 동작 |
| --- | --- | --- |
| 재시도 (`fatal: false`) | 네트워크 오류, `INVALID_RESPONSE`, HTTP 408, 429, 5xx | 최신 위치로 2초, 5초 뒤, 그 뒤로 15초마다 재시도. `Retry-After` 헤더(초 또는 HTTP 날짜)가 있으면 그 값을 쓰되 최소 2초, 최대 5분. 성공해야 간격이 2초로 돌아감 |
| 중단 (`fatal: true`) | HTTP 400, 401, 403, 404와 그 밖의 4xx, `INVALID_KEY`, `MISSING_KEY`, `MALFORMED_AUTHORIZATION`, `FORBIDDEN_ROLE`, `QUERY_KEY_NOT_ALLOWED`, `BAD_REQUEST`, `INVALID_*` | 한 번만 보고하고 서비스 설정이 바뀔 때까지 받아 오기를 멈춤. 지도는 계속 동작 |

재시도를 기다리는 동안에는 위치가 바뀌어도 받아 오지 않고 간격도 초기화하지 않습니다. 창이 만료되어도 마찬가지입니다. 예외는 마지막 시도 지점과 마지막 성공 지점 **둘 다**에서 `refetchDistanceMeters` 넘게 움직인 경우입니다. 이때는 곧바로 한 번 받아 오고, 실패하면 간격이 이어집니다.

### 수집 검증

1. `drop:collect`가 오면 드롭을 숨기고 `onCollect`를 호출한 뒤 `POST {baseUrl}/v1/drops/collect`에 `{ dropId, collectId, userId, fix: { lng, lat, accuracyMeters, timestamp } }`를 보냅니다.
2. `200`이면 `onCollectVerified`가 `{ receipt, replayed }`를 받습니다.
3. 아니면 `onCollectRejected`가 서비스 오류 `code`와 HTTP `status`를 받습니다. 네트워크 실패는 `NETWORK_ERROR`(`status` 0), 형식 오류는 `INVALID_RESPONSE`입니다.

거절된 드롭을 다시 보여 줄지는 코드로 정해집니다 (`shouldRestoreRejectedDrop(code, status)`).

| 결과 | 코드 |
| --- | --- |
| **다시 나타남** (나중에 성공할 수 있음) | `TOO_FAR`, `TELEPORT`, `STALE_FIX`, `QUOTA_EXCEEDED`, `NETWORK_ERROR`, `INVALID_RESPONSE`, HTTP 5xx |
| **계속 숨김** (다시 받아 와도) | `ALREADY_COLLECTED`, `DROP_EXPIRED`, `DROP_NOT_FOUND`, `COLLECT_ID_CONFLICT`, 그 밖의 코드 |

숨긴 드롭은 서비스 설정(`baseUrl`, `apiKey`, `channel`, `radiusMeters`, `userId`)이 바뀌면 비워집니다.

저수준 클라이언트 `fetchNearbyDrops` / `verifyDropCollect`도 export됩니다.

## 서비스가 검증하는 순서

드롭 캠페인은 비밀 `seed`와 밀도, 시간 창으로 정의되고, 개별 드롭은 저장하지 않습니다. 시간 창과 geohash-6 셀마다 시드 기반 난수로 드롭이 결정되므로 모든 클라이언트가 같은 드롭을 보고, 검증기는 드롭 id(`d1.<campaignId>.<window>.<geohash>.<index>`)에서 드롭을 다시 만들어 냅니다.

`POST /v1/drops/collect`는 다음을 순서대로 확인합니다.

| 순서 | 검사 | 실패 코드 |
| --- | --- | --- |
| 1 | 이미 쓴 `collectId`인가. 같은 드롭·사용자면 원래 영수증을 `replayed: true`로 반환 | `COLLECT_ID_CONFLICT` (409) |
| 2 | 드롭이 존재하고 현재 또는 직전 창에 속하는가 | `DROP_NOT_FOUND`, `DROP_EXPIRED` |
| 3 | `fix.timestamp`가 서버 시각 ±2분 이내인가 | `STALE_FIX` |
| 4 | 거리 ≤ `collectRadiusMeters` + min(`accuracyMeters`, 30) | `TOO_FAR` |
| 5 | 이 사용자가 이 드롭을 아직 수집하지 않았는가 | `ALREADY_COLLECTED` |
| 6 | 직전 검증 수집 이후 속도가 90 m/s 이하인가 (지하철·자동차 허용) | `TELEPORT` |

순간이동 판정의 경과 시간은 클라이언트 fix 시각이 아니라 **서버 검증 시각**(`collectedAt`, 최소 1초) 차이를 씁니다. 클라이언트 시각은 각각 2분까지 어긋날 수 있어서, 그대로 쓰면 가짜 이동 시간이 더해지기 때문입니다.

성공하면 수집을 저장하고 `{ receipt }`를 반환하며 `drop.collected` 웹훅을 보냅니다. 무료 키는 월 할당량을 넘으면 `429 QUOTA_EXCEEDED`를 받습니다.

## 영수증과 웹훅으로 보상 지급

영수증은 `base64url(canonicalJSON(claims)).base64url(HMAC-SHA256)` 형식이고, 앱마다 다른 비밀키로 서명됩니다. 앱 서버에서 `@maprama/api/verify`로 검증하세요. 영수증 비밀키는 `GET /v1/receipts/secret`(admin 키)으로 받습니다.

```ts
import { verifyReceipt } from '@maprama/api/verify';

const r = await verifyReceipt(receiptFromClient, process.env.MAPRAMA_RECEIPT_SECRET!);
if (r.ok && r.claims.userId === session.userId) {
  await grantReward(r.claims.userId, r.claims.dropId, r.claims.payload); // dropId+userId로 멱등
}
```

::: warning userId는 서비스가 인증하지 않습니다
`client` 키로 호출하는 collect는 요청 본문의 `userId`를 믿습니다. 영수증은 "그 `userId`로 위치와 시간이 검증되었다"는 증명이지 "그 사용자가 누구인지"의 증명이 아닙니다. **앱 서버는 `claims.userId`를 자기 인증 세션의 사용자와 반드시 대조**하세요. 자세한 내용은 [보안 모델](/service/webhooks-receipts#보안-모델)에 있습니다.
:::

전체 흐름과 웹훅 서명 검증은 [웹훅과 영수증 검증](/service/webhooks-receipts)에 있습니다.

## 네이티브 엔진에서는

v2는 드롭 종류마다 메시 하나, 종류 × 희귀도마다 드로 콜 하나로 인스턴싱하고, 흔들림·회전을 버텍스 셰이더에서 처리할 계획입니다. 수집 판정은 균일 격자로 후보를 추린 뒤 `haversineMeters`로 거리를 잽니다. 목표는 활성 5,000개, 화면 1,500개입니다 (측정 전 목표).
