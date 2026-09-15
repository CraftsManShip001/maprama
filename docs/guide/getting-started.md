# 설치: bare RN · Expo

## 요구 사항

- React Native **0.76 이상, New Architecture(Fabric) 활성화**. 구 아키텍처는 지원하지 않습니다.
- iOS 15.1+, Android API 24+
- `react` 18.3+ 또는 19, `react-native-webview` 13.12+ (v1 엔진 호스트)

## bare React Native

```sh
npm i @diorama/react-native react-native-webview
cd ios && pod install
```

기기 위치(`location` prop의 `source: 'device'`)를 쓰면 권한을 직접 추가합니다.

- iOS `Info.plist`: `NSLocationWhenInUseUsageDescription`
- Android `AndroidManifest.xml`: `android.permission.ACCESS_FINE_LOCATION` (그리고 `ACCESS_COARSE_LOCATION`)

## Expo

development build 또는 prebuild가 필요합니다. Expo Go에서는 동작하지 않아요.

```sh
npx expo install @diorama/react-native react-native-webview
# 기기 위치에 권장 (선택)
npx expo install expo-location
```

`app.json`에 config plugin을 추가합니다.

```json
{
  "expo": {
    "plugins": [
      [
        "@diorama/react-native",
        { "features": ["characters", "drops", "labels", "travel"], "locationPermissionText": "지도에 내 위치를 보여 줄게요" }
      ]
    ]
  }
}
```

| 옵션 | 타입 | 기본값 | 효과 |
| --- | --- | --- | --- |
| `features` | `('characters' \| 'drops' \| 'labels' \| 'travel')[]` | 전부 | `Info.plist`의 `DioramaFeatures`와 Android `<meta-data android:name="dev.diorama.features">`에 기록. v1 엔진은 무시하고, 네이티브 엔진은 쓰지 않는 모듈을 빼는 데 쓸 예정 |
| `locationPermissionText` | `string` | 일반 문구 | iOS `NSLocationWhenInUseUsageDescription` |
| `location` | `boolean` | `true` | iOS 사용 설명과 Android 위치 권한 추가. `location.source: 'device'`를 쓰지 않으면 `false` |

## 첫 지도

```tsx
import { useRef } from 'react';
import { DioramaMap, Character, type DioramaMapRef } from '@diorama/react-native';

export function FirstMap() {
  const map = useRef<DioramaMapRef>(null);
  return (
    <DioramaMap
      ref={map}
      world={{ kind: 'procedural', layout: 'town' }}
      theme={{ base: 'urban', timeOfDay: 'golden', zoomOut: 'keepGameView' }}
      labels={{ enabled: true, style: 'holo', icons: 'auto' }}
      ui={{ locationPuck: true, attribution: true }}
      camera={{ pitch: 45, follow: 'me' }}
      location={{ source: 'simulated' }}
      onReady={({ engine }) => console.log('engine', engine.name, engine.version)}
      onPress={(e) => map.current?.travel('me', e.coordinate, ['walk'])}
      onError={(e) => console.warn(e.code, e.message)}
      style={{ flex: 1 }}
    >
      <Character id="me" isPlayer name="나" follow="location" showNameTag />
    </DioramaMap>
  );
}
```

- `world`는 **마운트 시점에 한 번** 읽습니다. `procedural`(데모 레이아웃 `town`/`grid`), `url`(WorldData JSON 주소), `data`(인라인 객체) 중 하나예요.
- `theme`, `labels`, `ui`, `camera`가 바뀌면 필요한 프로토콜 명령만 엔진으로 갑니다.
- `labels`를 생략해도 엔진 기본값으로 홀로그램 라벨이 켜집니다. 끄려면 `labels`에 `enabled: false`를 넘기세요.
- `onError`는 절대 throw하지 않습니다. 엔진 코드(`world_load_failed`, `model_load_failed`, `unsupported` …)와 호스트 코드(`invalid_message`, `host_crashed`, `host_load_failed`, `location_unavailable`, `location_permission_denied`, `drops_fetch_failed`, `listener_error`)가 함께 옵니다. `fatal: true`면 지도를 계속 쓸 수 없는 오류입니다. 단 `drops_fetch_failed`의 `fatal: true`는 그 `DropLayer`만 받아 오기를 멈췄다는 뜻입니다.

실제 동네로 바꾸려면 `world`를 URL로 바꾸세요. 호스팅 서비스를 쓰면 이렇게 됩니다.

```tsx
<DioramaMap world={{ kind: 'url', url: 'https://api.example/v1/worlds/seongsu.json?key=YOUR_CLIENT_KEY' }} ui={{ attribution: true }} />
```

::: warning 출처 표기
OSM 기반 월드를 보여 줄 때는 `ui.attribution`을 켜 두세요. ODbL은 `© OpenStreetMap contributors` 표기를 요구합니다.
:::

## 명령이 전달되는 방식

`DioramaMap`은 prop 변화를 최소한의 프로토콜 명령으로 바꿉니다.

| 바뀐 것 | 보내는 명령 |
| --- | --- |
| `theme` | `setTheme` |
| `labels` | `setLabels` (+ 내용 함수면 평가 결과를 `setLabelContent`) |
| `ui` | `setUi` |
| `camera`에서 바뀐 필드만 | `setCamera` |
| 자식 컴포넌트 | `upsertCharacters`/`removeCharacters`, `setDropLayer`/`removeDropLayer`, `setGeofences`, `setOverlayAnchors` |

자식 컴포넌트의 변경은 애니메이션 프레임마다 종류별로 최대 한 번으로 묶입니다. 엔진이 `ready`를 보내기 전의 명령은 큐에 쌓였다가 `init` 직후 순서대로 나갑니다.

## 요청과 타임아웃

`project`, `route` 같은 요청과 `travel`은 프로미스를 돌려줍니다.

- 요청은 `requestTimeoutMs`(기본 5000 ms), `travel`의 시작 대기는 `travelStartTimeoutMs`(기본 10000 ms)로 제한됩니다. 호출마다 `options.timeoutMs` / `startTimeoutMs`로 바꿀 수 있습니다.
- 타임아웃은 **호출 시점부터** 잽니다. 엔진이 준비되기 전에 부른 호출도 멈춰 있지 않고, 제때 준비되지 않으면 `timeout`으로 reject됩니다. 명령이 엔진에 전달되면 그때부터 다시 잽니다.
- 두 prop은 타이머를 걸 때마다 최신 값을 읽으므로 바꾸면 다음 타이머부터 반영됩니다.
- 호스트가 치명적으로 실패하면(`host_load_failed`, 또는 `engine`에 등록된 호스트가 없음) 대기 중인 요청과 이동이 모두 그 코드로 reject됩니다.

## 다음 단계

- [월드 데이터와 타일](./world-data): 내 동네 데이터 만들기
- [테마](./themes): 프리셋과 덮어쓰기
- [플레이그라운드](/playground/): 옵션을 바꾸며 JSX 복사하기
- [`DioramaMapProps` 레퍼런스](/api/reference/react-native/interfaces/DioramaMapProps)
