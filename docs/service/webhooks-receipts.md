# 웹훅과 영수증 검증

드롭 수집이 서비스에서 검증되면 두 가지가 생깁니다.

1. 클라이언트가 받는 **영수증** (`POST /v1/drops/collect` 응답의 `receipt`)
2. 앱 서버로 가는 **웹훅** `drop.collected`

둘 다 앱 서버에서 검증한 뒤에 보상을 지급하세요.

```
기기 ── drop:collect ──▶ @diorama/react-native ── POST /v1/drops/collect ──▶ 서비스
  ▲                                                                        │
  │ onCollectVerified { receipt }                                          │ 검증 성공
  │                                                                        ▼
앱 ── receipt ──▶ 앱 서버 ◀── POST drop.collected (Diorama-Signature) ── 웹훅 전송
                   │
                   └─ verifyReceipt / verifyWebhookSignature → claims.userId 대조 → 멱등 지급
```

## 비밀키 두 가지

| 비밀키 | 얻는 곳 | 용도 |
| --- | --- | --- |
| 웹훅 서명 비밀 `whsec_...` | `POST /v1/webhooks` 응답 (처음 만들 때 또는 `rotateSecret: true`) | `Diorama-Signature` 검증 |
| 영수증 비밀 `receiptSecret` | `GET /v1/receipts/secret` (admin) 또는 `POST /v1/webhooks` 응답 | `verifyReceipt` |

영수증 비밀은 `HMAC-SHA256(RECEIPT_SECRET, "diorama-receipt:v1:" + appId)`로 앱마다 따로 파생되므로 한 앱이 다른 앱의 영수증을 위조할 수 없습니다.

## 웹훅 등록

```sh
curl -X POST https://api.example/v1/webhooks \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://game.example.com/diorama/webhook"}'
```

- 앱마다 엔드포인트 하나. 처음 만들 때 `whsec_...` 서명 비밀이 생깁니다.
- 이후 URL만 바꾸면 기존 비밀이 그대로 돌아오고 `secretRotated: false`가 옵니다. 이미 설정한 검증 코드가 계속 동작합니다.
- 비밀을 교체하려면 `rotateSecret: true`를 보냅니다. 새 비밀로 앱 서버를 바꾸기 전까지는 서명 검증이 실패하니 순서에 주의하세요.

```sh
curl -X POST https://api.example/v1/webhooks \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://game.example.com/diorama/webhook","rotateSecret":true}'
```

- `POST /v1/webhooks/test`는 `webhook.test` 이벤트를 동기로 보내고 시도 결과를 돌려줍니다.

### URL 정책

- URL은 공개 호스트 이름의 `https`여야 합니다.
- 거부: URL 안의 자격 증명, IP 리터럴 호스트(IPv4·IPv6 전부. 사설·링크 로컬·루프백 주소 포함), 단일 레이블 호스트, `localhost`, `*.local`, `*.internal`, `*.localdomain`, `*.home.arpa`.
- 로컬 개발 서버(`npm run dev:local`)는 `allowInsecureLocalWebhooks` 옵션을 켜서 `localhost`, `127.0.0.1`, `[::1]`의 http를 추가로 허용합니다. 이 옵션은 기본으로 꺼져 있고 Workers 배포(`src/worker.ts`)에서도 꺼져 있습니다.
- DNS로 사설 주소를 가리키는 호스트 이름은 등록 시점에 알아낼 수 없습니다. Workers의 외부 `fetch`는 사설 네트워크에 닿지 못합니다.

## 전송 형식

```http
POST /diorama/webhook
Content-Type: application/json
Diorama-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
Diorama-Event: drop.collected | webhook.test
Diorama-Delivery: evt_...
```

최대 3회 시도(1초, 4초 백오프), 시도마다 8초 타임아웃, 리다이렉트는 따라가지 않습니다.

## Node 앱 서버에서 검증

`@diorama/api/verify`는 의존성 없는 Web Crypto 함수만 담고 있어서 Node, Workers, Deno 어디서나 씁니다.

```ts
import express from 'express';
import { verifyWebhookSignature, verifyReceipt } from '@diorama/api/verify';

const app = express();

app.post('/diorama/webhook', express.text({ type: 'application/json' }), async (req, res) => {
  const sig = await verifyWebhookSignature(req.body, req.get('Diorama-Signature'), process.env.DIORAMA_WEBHOOK_SECRET!);
  if (!sig.ok) return res.status(400).send(sig.reason); // 'malformed' | 'mismatch' | 'expired'

  const event = JSON.parse(req.body);
  if (event.type === 'drop.collected') {
    const receipt = await verifyReceipt(event.data.receipt, process.env.DIORAMA_RECEIPT_SECRET!);
    if (receipt.ok) await grantReward(receipt.claims.userId, receipt.claims.dropId, receipt.claims.payload);
  }
  res.sendStatus(204);
});
```

::: warning 원문 본문으로 검증
서명은 **원문 문자열**에 대해 계산됩니다. JSON을 파싱했다가 다시 직렬화하면 검증이 실패합니다. 위 예처럼 `express.text`로 받으세요.
:::

## 클라이언트가 보낸 영수증

```ts
app.post('/rewards/claim', requireSession, async (req, res) => {
  const r = await verifyReceipt(req.body.receipt, process.env.DIORAMA_RECEIPT_SECRET!);
  if (!r.ok) return res.status(400).json({ error: r.reason }); // 'malformed' | 'mismatch'
  if (r.claims.userId !== req.session.userId) return res.status(403).end();
  await grantRewardOnce(r.claims.dropId, r.claims.userId, r.claims.payload);
  res.status(204).end();
});
```

영수증 claims: `v`, `appId`, `dropId`, `collectId`, `userId`, `payload`, `collectedAt`, `type`, `rarity`

## 보안 모델

- **서비스는 `userId`를 인증하지 않습니다.** `client` 키로 호출하는 collect는 요청 본문의 `userId`를 받습니다. 수정된 클라이언트는 다른 `userId`로 수집을 보낼 수 있고, 그러면 사용자별 `ALREADY_COLLECTED`/`TELEPORT` 검사도 우회됩니다.
- 영수증은 "서비스가 그 `userId`에 대해 드롭, 위치, 시간을 검증했다"를 증명할 뿐 "그 사용자가 누구인지"를 증명하지 않습니다.
- 그러므로 **앱 서버는 `claims.userId`를 자기 인증 사용자와 반드시 대조**하고, `dropId + userId`로 멱등하게 지급하세요. 다른 사용자의 세션이 전달한 영수증은 거부하세요.
- 순간이동(`TELEPORT`) 판정은 서버 검증 시각만 씁니다. 클라이언트가 보낸 fix 시각은 쓰지 않습니다 ([드롭 검증 순서](/guide/drops#서비스가-검증하는-순서)).
- 웹훅 URL은 공개 https 호스트 이름으로 제한됩니다 ([URL 정책](#url-정책)).
- 계획된 후속 작업: collect를 `server` 키로만 허용하는 서버 경유 방식, 또는 앱 서버가 발급한 서명 사용자 토큰으로 서비스가 `userId`를 직접 인증하는 방식.
- `RECEIPT_SECRET`을 교체하면 기존 영수증이 모두 무효가 되고 모든 앱의 `receiptSecret`이 바뀝니다.
