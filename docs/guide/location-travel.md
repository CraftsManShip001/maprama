# 위치와 이동

## 위치 소스

`location` prop이 플레이어 위치가 어디서 오는지 정합니다. 기본은 `{ source: 'external' }`입니다.

| `source` | 동작 |
| --- | --- |
| `device` | 기기 GPS. 엔진이 튀는 값을 걸러 내고 도로를 따라 움직입니다 |
| `external` | 앱이 `ref.pushLocation(fix)`로 위치를 넣습니다 (자체 위치 SDK, 서버 재생 등) |
| `simulated` | 월드의 데모 루프를 걷는 가짜 위치 |

위치를 따라가는 것은 `follow="location"`인 캐릭터뿐입니다. `Character`의 `follow`를 생략하면 `none`이라서 `travel`이나 `position`으로만 움직입니다.

### 기기 위치 제공자

`location` prop: `{ source: 'device', provider?: 'auto' | 'expo-location' | 'webview' }`

- **`expo-location` 설치됨** (`auto`의 우선 선택): 라이브러리가 포그라운드 권한을 요청하고 위치를 감시해 엔진에 넣습니다. 엔진은 `external` 소스로 동작해요. 옵셔널 peer dependency라서 설치하지 않은 앱도 번들이 깨지지 않습니다.
- **그 외** (`webview`): 엔진이 WebView 안에서 `navigator.geolocation`을 읽습니다. 추가 네이티브 의존성이 없어요. WebView에 geolocation이 없거나 실패하면 `onError`로 `location_unavailable`이 옵니다.

어느 쪽이든 [플랫폼 권한](./getting-started#bare-react-native)은 필요합니다. 권한이 거부되면 `onError`로 `location_permission_denied`가 옵니다.

### 외부 위치 넣기

```ts
map.current?.pushLocation({ lng: 127.0565, lat: 37.5445, accuracyMeters: 8, headingDeg: 90, speedMps: 1.3, timestamp: Date.now() });
```

`pushLocation`은 `source: 'external'`일 때만 반영됩니다. 다른 소스에서는 엔진이 조용히 무시합니다.

### 위치 보정

GPS와 외부 위치 fix는 같은 알파-베타 필터를 거칩니다. 값은 월드 단위 기준이고, `unitMeters`가 8인 월드라면 1 단위가 8 m입니다.

- 새 fix를 예측값에 0.6 비율로, 속도는 0.7 비율로 섞습니다. 프로토타입(0.5 / 0.5)보다 모퉁이를 잘 따라가도록 조정한 값입니다.
- 이상값 판정 거리는 fix 간격 1초당 `4.5 + 현재 속도` 단위입니다. 예측값과 현재 추정값 **둘 다**에서 멀 때만 이상값으로 버립니다.
- 이상값이 3번 연속 나오면 기기가 실제로 이동한 것으로 보고 추정값을 fix로 옮깁니다.
- 보고된 정확도가 12.5 단위보다 나쁜 fix는 버립니다.
- 캐릭터는 보정된 위치까지 도로를 따라 걸어갑니다. 40 단위보다 멀면 걷지 않고 순간이동합니다.
- `travel` 중인 캐릭터는 도착할 때까지 위치 fix를 따르지 않습니다.

## 이동 (`travel`)

목적지와 **이동 수단의 순서**를 주면 엔진이 경로를 짜서 캐릭터를 움직입니다.

```ts
const result = await map.current!.travel('me', destination, ['walk', 'car', 'walk'], { timeoutMs: 120_000 });
console.log(result.legs); // travel:start가 보고한 실제 구간
```

| 수단 | 설명 |
| --- | --- |
| `walk` | 도보 |
| `bike` | 자전거 |
| `car` | 자동차 |
| `plane` | 비행기. 출발점에서 목적지까지 곧게 날아갑니다 (12 월드 단위보다 짧으면 걷기로). 앞뒤의 다른 수단은 구간을 만들지 않아서 `['walk', 'plane', 'walk']`도 `plane` 구간 하나가 됩니다 |
| `subway` | 지하철. 가장 가까운 역까지 걸어가서 목적지에 가장 가까운 역까지 탑니다 |

구간마다 탈것이 나타나고 사라집니다. 캐릭터 애니메이션은 [캐릭터와 모델](./characters#애니메이션-클립)에 있어요.

### 프로미스와 타임아웃

- 프로미스는 `travel:arrive`에서 resolve됩니다.
- `MapramaError`로 reject되는 코드: `travel_cancelled`(취소), `timeout`, `engine_reloaded`(WebView 재생성), `unmounted`, 그리고 치명적인 호스트 오류 코드(`host_load_failed` 등).
- `startTimeoutMs`(기본은 map의 `travelStartTimeoutMs`, 10000 ms)는 `travel:start`까지 기다리는 시간, `options.timeoutMs`는 전체 이동 시간을 제한합니다. 전체 타임아웃이 지나면 `cancelTravel`도 보냅니다.
- 타임아웃은 **호출 시점부터** 잽니다. 엔진이 준비되기 전에 부른 `travel`도 제때 준비되지 않으면 `timeout`으로 reject되고, 큐의 명령은 버려집니다. 명령이 엔진에 전달되면 타임아웃은 그때부터 다시 잽니다.
- `requestTimeoutMs`와 `travelStartTimeoutMs` prop은 타이머를 걸 때마다 최신 값을 읽습니다.
- 호스트가 치명적으로 실패하면(`host_load_failed`, 또는 `engine`에 등록된 호스트가 없음) 대기 중인 요청과 이동이 모두 그 코드로 reject됩니다.
- 새 월드를 로드하면 진행 중인 이동은 `travel:cancel`로 끝납니다.
- `ref.cancelTravel('me')`로 멈춥니다. 모르는 캐릭터면 엔진이 `unknown_character` 오류를 보냅니다.

[플레이그라운드](/playground/)에서 수단 순서를 바꾸고 지도를 탭해 보세요.

### 이동 없이 경로만

```ts
const route = await map.current!.route(from, to, ['walk', 'subway']);
const snapped = await map.current!.snapToRoad(coordinate, 30); // 30 m 안에 도로가 없으면 null
```

`route`는 `travel`과 같은 경로 계획기를 씁니다.

## 연속 값 구독

위치처럼 계속 바뀌는 값은 **구독한 경우에만** 엔진이 보냅니다. 기본 간격은 250 ms입니다.

```tsx
const me = useCharacterPosition(map, 'me', { throttleMs: 500 }); // { coordinate, headingDeg, speedMps } | null
const camera = useCameraState(map, { throttleMs: 250 });
```

- `map`에는 `useRef`의 ref 객체, API 자체, 또는 `MapramaView` 안에서 `null`(감싸고 있는 지도)을 넘길 수 있습니다.
- 지도가 훅보다 늦게 마운트되어도(조건부 렌더링 등) 마운트되는 순간 구독합니다.
- 다른 지도로 바뀌면 값이 `null`로 초기화되고 새 지도를 구독합니다. 이전 지도의 값이 남지 않습니다.
- 캐릭터 위치 이벤트는 위치, 방향, 속도가 바뀌었을 때만 옵니다.

직접 구독하려면 `subscribe`를 씁니다. 같은 토픽의 엔진 구독은 공유되고 참조 카운트로 관리됩니다.

```ts
const off = map.current!.subscribe('travel:progress', (e) => setProgress(e), { id: 'me', throttleMs: 200 });
```

토픽: `character:position`, `camera:change`, `travel:progress`

## 이벤트

| 이벤트 | 시점 |
| --- | --- |
| `travel:start` | 경로가 정해지고 구간(legs)이 확정됨 |
| `travel:progress` | 구독 시 진행 상황 |
| `travel:arrive` | 도착 |
| `travel:cancel` | 취소됨 (`cancelTravel`, 새 월드 로드, 캐릭터 제거) |

모든 타입은 [`EngineEvent`](/api/reference/protocol/type-aliases/EngineEvent)에 있습니다.

## 호스팅 서비스의 대중교통

역과 노선 데이터는 `GET /v1/transit/stations?bbox=`와 `GET /v1/transit/lines/{lineId}`로 받을 수 있습니다. 월드 JSON의 `stations[]`는 `maprama-osm`이 OSM에서 채웁니다.
