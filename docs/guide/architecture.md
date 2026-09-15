# 엔진 구조와 로드맵

## 층 구조

```
┌────────────────────────────────────────────────────────────┐
│ 앱: <MapramaView> · <Character> · ref.travel() · hooks       │  @maprama/react-native
├────────────────────────────────────────────────────────────┤
│ 선언형 diff · 프레임 배치 · 요청/응답 상관 · 구독 참조 카운트 │
├────────────────────────────────────────────────────────────┤
│ EngineHost: send(command) / onEvent(listener) / ready      │
│   ├─ WebViewEngineHost (v1) → react-native-webview          │
│   └─ Native host (v2)        → JSI TurboModule              │
├────────────────────────────────────────────────────────────┤
│ @maprama/protocol 봉투: {"v":1,"seq":N,"kind":…,"msg":…}    │  같은 코덱, 같은 검증
├───────────────────────────────┬────────────────────────────┤
│ @maprama/engine-web (three.js)│ @maprama/engine-native      │
│ WebView 또는 브라우저          │ C++ 코어 + MapLibre Native  │
└───────────────────────────────┴────────────────────────────┘
```

앱 코드는 위 두 층만 봅니다. 엔진은 **프로토콜 메시지만** 알고, 호스트는 문자열을 옮기기만 합니다.

## 프로토콜

`@maprama/protocol`이 유일한 계약입니다.

- **봉투**: `encodeCommand(cmd, seq)` / `decodeEvent(text)`가 `{ v: PROTOCOL_VERSION, seq, kind: 'cmd' | 'evt', msg }` JSON 문자열을 만들고 읽습니다. 디코드는 항상 검증을 포함하며 실패하면 이유를 돌려줍니다.
- **명령** (호스트 → 엔진, `ENGINE_COMMAND_TYPES` 20종): `init`, `setTheme`, `setLabels`, `setLabelContent`, `setUi`, `setCamera`, `upsertCharacters`, `removeCharacters`, `setLocationSource`, `pushLocation`, `travel`, `cancelTravel`, `setDropLayer`, `removeDropLayer`, `setGeofences`, `setBuildingStyle`, `setOverlayAnchors`, `subscribe`, `unsubscribe`, `request`
- **요청** (`request` + `requestId` → `response`): `project`, `unproject`, `snapToRoad`, `route`
- **이벤트** (엔진 → 호스트, `ENGINE_EVENT_TYPES` 16종): `ready`, `error`, `labelsIndex`, `map:press`, `building:press`, `drop:collect`, `travel:start`, `travel:progress`, `travel:arrive`, `travel:cancel`, `geofence:enter`, `geofence:exit`, `character:position`, `camera:change`, `overlay:positions`, `response`

전체 타입은 [`EngineCommand`](/api/reference/protocol/type-aliases/EngineCommand)와 [`EngineEvent`](/api/reference/protocol/type-aliases/EngineEvent)에 있습니다.

### 오류 코드

| 코드 | 의미 |
| --- | --- |
| `invalid_message` | 명령이 디코드/검증에 실패. 엔진은 계속 동작 |
| `unsupported` | 엔진이 이 명령이나 옵션을 구현하지 않음 |
| `world_load_failed`, `model_load_failed` | 에셋 로드 실패 |
| `internal` | 예기치 않은 엔진 오류 |

엔진은 다른 코드도 보낼 수 있습니다. 호스트는 엔진의 예전 코드 `NOT_IMPLEMENTED`를 `unsupported`로 정규화합니다.

## 호환성 규칙

1. **같은 메시지, 같은 의미.** 두 엔진은 같은 봉투를 같은 방식으로 디코드합니다. 네이티브 코어는 TypeScript 패키지에서 내보낸 픽스처로 `decodeCommand`와 결과가 일치하는지 테스트하고, C++이 만든 이벤트는 TypeScript `decodeEvent`로 다시 검증합니다.
2. **모르면 `unsupported`.** 아직 구현하지 않은 명령은 조용히 무시하지 않고 `unsupported` 오류(요청이면 오류 응답)를 보냅니다. 앱은 `onError`로 알 수 있고 지도는 계속 동작합니다.
3. **추가는 버전 안에서, 파괴적 변경은 버전 올림.** 새 필드와 새 명령은 선택 사항으로 추가하고, 의미를 바꾸는 변경은 `PROTOCOL_VERSION`을 올립니다. 타일 기반 월드 같은 프로토콜 추가는 두 엔진이 같은 릴리스에서 함께 지원합니다.

웹 엔진은 핸들러가 등록되지 않은 명령, 요청, 구독 토픽에 이 규칙대로 `unsupported`를 보냅니다 (요청은 실패한 `response`). [플레이그라운드](/playground/)도 같은 규칙을 따릅니다. 엔진이 어떤 명령에 `unsupported`로 답하면 콘솔 오류 대신 해당 컨트롤 아래에 짧은 안내를 띄우고, 나머지 지도는 계속 동작합니다.

## 엔진 호스트 교체

```tsx
import { registerEngineHost, createMessageChannelHost } from '@maprama/react-native';

registerEngineHost('native', NativeEngineHost);
<MapramaView engine="native" world={world} />;
```

`createMessageChannelHost(kind, post)`는 JSI나 WebSocket처럼 문자열을 옮기는 어떤 전송 수단으로도 `EngineHost`를 만들어 줍니다. 앱의 다른 코드는 바뀌지 않습니다.

### 웹에서 엔진 직접 쓰기

플레이그라운드와 테스트는 WebView 없이 같은 엔진을 페이지 안에서 돌립니다.

```ts
import { createEngine, createDirectTransport } from '@maprama/engine-web';

const transport = createDirectTransport();
transport.onEvent((event) => console.log(event));
const engine = createEngine(document.getElementById('map')!, { transport });
transport.postCommand({ type: 'init', world: { kind: 'procedural', layout: 'town' }, theme: { base: 'urban' }, labels: {}, ui: {}, locationSource: 'simulated' });
```

## v1: 웹 엔진

- three.js 기반. `react-native-webview` 안에서는 `createWebViewTransport`가 `message` 이벤트와 `window.ReactNativeWebView.postMessage`로 통신합니다.
- `dist/engine.html` 한 파일(약 900 KiB)로 번들되어 WebView의 `source` prop에 `{ html }`로 들어갑니다.
- 프로토콜 명령 20종을 모두 처리합니다. 렌더 코어(월드, 건물, 테마, 카메라, 요청) 위에 캐릭터, 이동, 위치 소스, 드롭, 라벨, 지오펜스, 오버레이 앵커, 구독이 올라갑니다.
- 월드가 로드되기 전에 받은 캐릭터, 드롭 레이어, 지오펜스는 보관했다가 월드가 로드되면 적용합니다.
- 새 월드를 로드하면 진행 중인 이동은 `travel:cancel`로 끝나고, 캐릭터는 경위도 위치를 유지하며, 드롭 레이어와 지오펜스는 새 좌표계로 다시 배치되고, `labelsIndex`가 다시 옵니다.

### WebView 보안

`WebViewEngineHost`는 인라인 엔진 문서만 띄우도록 잠겨 있습니다. 다른 페이지가 엔진을 대체해 `drop:collect` 같은 이벤트를 위조하지 못하게 하기 위해서입니다.

- `originWhitelist`는 `['about:blank', 'about:srcdoc', 'data:*']`입니다. 엔진 문서가 로드된 뒤에는 `onShouldStartLoadWithRequest`가 `data:`도 거부합니다.
- http(s) 링크는 `Linking.openURL`로 시스템 브라우저에서 열리고, `file:`, `javascript:`, 커스텀 스킴은 거부됩니다.
- `allowFileAccess={false}`, `mixedContentMode="never"`입니다.
- 화이트리스트는 탐색에만 적용되고 엔진의 리소스 로드(월드 JSON, glTF 모델)에는 적용되지 않습니다. 파일 접근이 꺼져 있으므로 모델과 월드는 https URL이나 `data:` URI로 주는 것이 안전합니다. [캐릭터와 모델](./characters#모델-파일-넘기기)을 보세요.

## v2: 네이티브 C++ 엔진

### 현재 상태: M1 (평면 지도 + 카메라)

`@maprama/engine-native`를 import하면 `native` 엔진 호스트가 등록되고 `<MapramaView engine="native">`가 네이티브 엔진으로 동작합니다. 네이티브 코드가 들어간 개발 빌드(New Architecture)가 필요하며 Expo Go에서는 동작하지 않습니다.

```tsx
import '@maprama/engine-native';

<MapramaView engine="native" world={{ kind: 'data', world }} camera={{ center, distance: 400, pitch: 45 }} />
```

| 항목 | M1 상태 |
| --- | --- |
| 렌더러 | 공식 prebuilt MapLibre Native SDK (iOS CocoaPods `MapLibre` 6.30, Android `org.maplibre.gl:android-sdk` 13.6.1). 포크와 패치 큐는 M2(커스텀 건물 레이어)부터 |
| 월드 | `data`·`url` WorldData를 평면 지도로 렌더 (배경, 수면·공원 면, 등급별 도로 선, 건물 footprint 면, POI·역 원). `procedural`은 `unsupported` 치명 오류 |
| 카메라 | `setCamera` (병합, `distance`가 `zoom`보다 우선, `animate`), 팬·핀치 줌·회전·피치(0–60°) 제스처. 거리 한계는 웹 엔진과 같은 14–150 월드 단위 |
| 이벤트 | `ready`, `camera:change` (구독 + `throttleMs`), `project`/`unproject` 응답 |
| 그 밖 | 나머지 명령은 경고 로그만 남기고 무시. `snapToRoad`/`route`는 `unsupported` 응답, `setCamera.follow`는 경고 (캐릭터는 M3) |

같은 `CameraState`에서 두 엔진이 같은 지면 범위를 보이도록 `distance`는 웹 엔진의 40° 시야각을 기준으로 MapLibre 줌에 대응시킵니다 (프로토콜 `zoom` z = MapLibre 줌 z − 1). 공식 SDK는 C++ `mbgl` 헤더가 아니라 Obj-C/Java API를 제공하므로, C++ 코어는 플랫폼이 구현하는 작은 `MapAdapter` 인터페이스(스타일 JSON, 카메라, project/unproject, URL 로드)로 지도를 움직입니다. M2에서 패치된 `mbgl` 기반 어댑터가 이를 대체합니다. 예제 앱의 "9. Native engine (M1)" 화면에서 확인할 수 있습니다.

### 결정

| 주제 | 결정 |
| --- | --- |
| RN | New Architecture 전용: Fabric 뷰 + JSI TurboModule. 브리지 폴백 없음 |
| 렌더러 | M1은 공식 prebuilt MapLibre Native SDK. M2부터 **MapLibre Native**(BSD-2-Clause)를 포크해 내장하며, 긴 수명의 갈라진 포크가 아니라 upstream 위에 rebase하는 **패치 큐**로 유지 |
| 코드 공유 | 프로토콜·시뮬레이션·디오라마 레이어는 C++ 공통 코어 하나. iOS(Obj-C++)와 Android(Kotlin/JNI) 래퍼는 얇게 |
| C++ 표준 | C++17 (RN의 C++20 툴체인 안에서 컴파일) |
| JSON | JavaScript 의미를 그대로 재현하는 자체 파서. `decodeCommand`와 바이트 단위로 같은 오류를 내기 위함 |

### 층

```
TS API (@maprama/react-native, engine="native")             JS 스레드
Fabric + JSI: MapramaNativeView · MapramaEngineModule
플랫폼 래퍼: iOS MTKView·CADisplayLink / Android TextureView·Choreographer
C++ 코어: Dispatcher · WorldStore · Projection · ThemeResolver · LabelSystem
          CameraController · CharacterSystem · TravelPlanner · DropSystem · GeofenceSystem
MapLibre Native (패치) + MapramaLayer: 돌출·외벽·지붕, 인스턴싱 드롭, 스키닝 glTF, 홀로 라벨
GPU: Metal (iOS) · Vulkan (Android) · GL ES 3 폴백
```

### 디오라마 레이어

MapLibre 스타일 스펙에 `type: "maprama"` 레이어를 추가하는 작은 패치(약 4개)로, 그리기는 커스텀 드로어블 API를 통해 코어의 `MapramaLayer`에 위임합니다. 스타일 순서와 줌 범위에 참여하고 fill-extrusion·심볼과 깊이를 공유할 수 있어서, 커스텀 레이어 API만 쓰는 방식보다 이 방식을 골랐습니다.

### 타일

- 베이스맵(디오라마 바깥의 평면 지도)과 넓은 지역의 WorldData 두 역할로 벡터 타일과 PMTiles를 씁니다.
- WorldData 타일 스키마(MVT v2, extent 4096, 줌 12–16):

| 레이어 | 지오메트리 | 속성 | WorldData 필드 |
| --- | --- | --- | --- |
| `maprama_roads` | LineString | `id`, `cls`, `name`?, `bridge`? | `roads[]` |
| `maprama_buildings` | Polygon | `id`, `height_m`, `levels`?, `kind`?, `name`? | `buildings[]` |
| `maprama_water` | Polygon | 없음 | `water[]` |
| `maprama_parks` | Polygon | `name`? | `parks[]` |
| `maprama_pois` | Point | `id`, `name`, `cat` | `pois[]` |
| `maprama_stations` | Point | `id`, `name` | `stations[]` |
| `maprama_districts` | Point | `name`, `water`? | `districts[]` |

월드 수준 필드는 PMTiles 메타데이터의 `"maprama"` 키(z/x/y 소스는 `…/maprama.json`)에 둡니다.

### 동등성 매트릭스

| 기능 | 프로토콜 | engine-web | engine-native |
| --- | --- | --- | --- |
| 봉투 코덱 + 검증 | `decodeCommand` / `encodeEvent` | v1 | **M0** (적합성 테스트) |
| 투영 | `createProjection` | v1 | **M0** |
| WorldData `data` 로드 | `init.world` | v1 | M0 저장, M1 렌더 |
| WorldData `url` / `procedural` | `init.world` | v1 | M1 |
| 카메라 + 제스처 | `setCamera`, `camera:change`, `project`/`unproject` | v1 | M1 |
| 구독 | `subscribe` / `unsubscribe` | v1 | M1 |
| 건물: 돌출, 외벽, 지붕, 매스 | `setTheme`, `setBuildingStyle` | v1 | M2 |
| 테마 + 시간대 + 시네마틱 | `setTheme` | v1 | M2 |
| 라벨 (전 스타일, 커스텀 내용) | `setLabels`, `setLabelContent`, `labelsIndex` | v1 | **M2b** (코어 배치 + 네이티브 뷰; `ground`/`sign` 3D 라벨은 M2c) |
| 지도 UI | `setUi` | v1 | M2 |
| 탭 | `map:press`, `building:press` | v1 | M2 |
| 오버레이 앵커 | `setOverlayAnchors`, `overlay:positions` | v1 | M2 |
| 캐릭터 + 위치 소스 | `upsertCharacters`, `removeCharacters`, `setLocationSource`, `pushLocation`, `character:position` | v1 | M3 |
| 이동 + 경로 | `travel`, `cancelTravel`, `travel:*`, `snapToRoad`, `route` | v1 | M3 |
| 드롭 | `setDropLayer`, `removeDropLayer`, `drop:collect` | v1 | M3 |
| 지오펜스 | `setGeofences`, `geofence:*` | v1 | M3 |
| 줌아웃 게임 뷰 | `theme.zoomOut` | v1 | M4 |
| PMTiles / 타일 기반 WorldData | (프로토콜 추가) | 계획 | 계획 (웹과 같은 릴리스) |

### 마일스톤

- **M0 기반** (완료): 설계, C++ 인터페이스, JS와 동일한 JSON 코덱, `Projection`, `WorldStore`, `unsupported`로 응답하는 골격 디스패처, 픽스처 적합성 테스트, 패치 큐 도구
- **M1 지도가 화면에** (현재): 공식 prebuilt MapLibre SDK 위의 양 플랫폼 `MapramaNativeView` + `MapramaEngineModule`, `MapAdapter`, `init`(data/url)으로 평면 지도, 카메라·제스처, `project`/`unproject`, `camera:change` 구독. 명령 큐·프레임 스냅샷·`procedural` 월드는 뒤로 미룸
- **M2 디오라마 룩**: 돌출·외벽·지붕·매스, 스타일 테이블 + 탭 판정, `ThemeResolver`, 라벨 시스템(M2b: C++ 코어가 선택·배치하고 플랫폼 네이티브 뷰 풀이 그림), `labelsIndex`, 지도 UI, 탭, 오버레이 앵커
- **M3 게임 시스템**: cgltf 스키닝, `CharacterSystem`과 위치 소스, `TravelPlanner`(A*, 지하철 확장), 드롭, 지오펜스, 나머지 이벤트
- **M4 동등성과 성능**: 줌아웃 게임 뷰, [성능 예산](./performance#v2-네이티브-엔진-예산) 기기 측정, RN 예제 앱으로 웹·네이티브 나란히 매트릭스 전부 통과, `engine="native"` 베타
