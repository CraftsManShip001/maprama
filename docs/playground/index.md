---
title: 플레이그라운드
aside: false
outline: false
pageClass: dio-wide
prev: false
next: false
---

# 플레이그라운드

실제 `@diorama/engine-web`가 이 페이지 안에서 돌아갑니다. WebView 대신 `createDirectTransport()`로 같은 프로토콜 명령을 보내요. 옵션을 바꾸면 아래 코드 패널이 같은 설정의 `@diorama/react-native` JSX로 바뀌고, 테마는 JSON으로 복사할 수 있습니다.

<DioramaPlayground />

## 여기서 일어나는 일

| 조작 | 보내는 명령 |
| --- | --- |
| 월드 바꾸기 | `init` (절차 생성은 `procedural`, 샘플과 성수동은 `url`) |
| 테마 · 시간대 · 줌아웃 | `setTheme` |
| 카메라 거리 | `setCamera` |
| 라벨 | `setLabels`, 커스텀 내용이면 `labelsIndex`를 받은 뒤 `setLabelContent` |
| 이동 | `upsertCharacters`(플레이어, `follow: 'none'`), `subscribe`(`character:position`), `travel`, `cancelTravel`. 지도를 탭하면 `map:press` → `travel` |
| 드롭 | `setDropLayer` (기기 판정만. 캐릭터가 지나가면 `drop:collect`가 로그에 나옵니다) |

드롭의 **source** 버튼은 코드 패널만 바꿉니다. `service`를 고르면 호스팅 서비스용 `source="service"` JSX(`userId` 필수)가 나오고, 페이지는 서비스 없이 같은 모양의 데모 드롭을 계속 그립니다.

엔진이 어떤 명령에 `unsupported`로 답하면(예: 기능이 아직 없는 엔진 빌드) 해당 컨트롤 아래에 안내가 뜨고 나머지는 계속 동작합니다. 앱에서는 같은 상황이 `onError`의 `unsupported` 코드로 옵니다.

::: info 성수동 데이터
"성수동 (OSM)" 월드는 © OpenStreetMap contributors, ODbL 1.0 데이터입니다. 이 사이트의 Apache-2.0 라이선스와 별개이며, 출처 문구는 `/worlds/seongsu.world.ATTRIBUTION.txt`에 함께 배포됩니다.
:::
