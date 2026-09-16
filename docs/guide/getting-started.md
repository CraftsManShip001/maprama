# 설치: bare RN · Expo

## 요구 사항

- React Native **0.76 이상, New Architecture(Fabric) 활성화**. 구 아키텍처는 지원하지 않습니다.
- iOS 15.1+, Android API 24+
- `react` 18.3+ 또는 19, `react-native-webview` 13.12+ (v1 엔진 호스트)

## bare React Native

```sh
npm i @maprama/react-native react-native-webview
cd ios && pod install
```

기기 위치(`location` prop의 `source: 'device'`)를 쓰면 권한을 직접 추가합니다.

- iOS `Info.plist`: `NSLocationWhenInUseUsageDescription`
- Android `AndroidManifest.xml`: `android.permission.ACCESS_FINE_LOCATION` (그리고 `ACCESS_COARSE_LOCATION`)

## Expo

development build 또는 prebuild가 필요합니다. Expo Go에서는 동작하지 않아요.

```sh
npx expo install @maprama/react-native react-native-webview
# 기기 위치에 권장 (선택)
npx expo install expo-location
```

`app.json`에 config plugin을 추가합니다.

```json
{
  "expo": {
    "plugins": [
      [
        "@maprama/react-native",
        { "features": ["characters", "drops", "labels", "travel"], "locationPermissionText": "지도에 내 위치를 보여 줄게요" }
      ]
    ]
  }
}
```

| 옵션 | 타입 | 기본값 | 효과 |
| --- | --- | --- | --- |
| `features` | `('characters' \| 'drops' \| 'labels' \| 'travel')[]` | 전부 | `Info.plist`의 `MapramaFeatures`와 Android `<meta-data android:name="dev.maprama.features">`에 기록. v1 엔진은 무시하고, 네이티브 엔진은 쓰지 않는 모듈을 빼는 데 쓸 예정 |
| `locationPermissionText` | `string` | 일반 문구 | iOS `NSLocationWhenInUseUsageDescription` |
| `location` | `boolean` | `true` | iOS 사용 설명과 Android 위치 권한 추가. `location.source: 'device'`를 쓰지 않으면 `false` |

## 첫 지도

```tsx
import { useRef } from 'react';
import { MapramaView, Character, type MapramaViewRef } from '@maprama/react-native';

export function FirstMap() {
  const map = useRef<MapramaViewRef>(null);
  return (
    <MapramaView
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
    </MapramaView>
  );
}
```

- `world`는 **마운트 시점에 한 번** 읽습니다. `procedural`(데모 레이아웃 `town`/`grid`), `url`(WorldData JSON 주소), `data`(인라인 객체) 중 하나예요.
- `theme`, `labels`, `ui`, `camera`가 바뀌면 필요한 프로토콜 명령만 엔진으로 갑니다.
- `labels`를 생략해도 엔진 기본값으로 홀로그램 라벨이 켜집니다. 끄려면 `labels`에 `enabled: false`를 넘기세요.
- `onError`는 절대 throw하지 않습니다. 엔진 코드(`world_load_failed`, `model_load_failed`, `unsupported` …)와 호스트 코드(`invalid_message`, `host_crashed`, `host_load_failed`, `location_unavailable`, `location_permission_denied`, `drops_fetch_failed`, `listener_error`)가 함께 옵니다. `fatal: true`면 지도를 계속 쓸 수 없는 오류입니다. 단 `drops_fetch_failed`의 `fatal: true`는 그 `DropLayer`만 받아 오기를 멈췄다는 뜻입니다.

실제 동네로 바꾸려면 `world`를 URL로 바꾸세요. 호스팅 서비스를 쓰면 이렇게 됩니다.

```tsx
<MapramaView world={{ kind: 'url', url: 'https://api.example/v1/worlds/seongsu.json?key=YOUR_CLIENT_KEY' }} ui={{ attribution: true }} />
```

::: warning 출처 표기
OSM 기반 월드를 보여 줄 때는 `ui.attribution`을 켜 두세요. ODbL은 `© OpenStreetMap contributors` 표기를 요구합니다.
:::

## 명령이 전달되는 방식

`MapramaView`은 prop 변화를 최소한의 프로토콜 명령으로 바꿉니다.

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

## 설치 문제 해결

실제 도입 과정에서 확인된 걸림돌 세 가지입니다.

### 경로에 한글이나 공백이 있을 때

CocoaPods가 설치 경로를 유니코드 정규화하는 단계에서 죽습니다.

```
Pod::Config#installation_root → String#unicode_normalize
Encoding::CompatibilityError: Unicode Normalization not appropriate for ASCII-8BIT
```

- `LANG`, `LC_ALL`, `RUBYOPT=-Eutf-8`을 모두 걸어도 통과하지 않습니다 (CocoaPods 1.17 / Ruby 4.0에서 확인).
- `expo prebuild`는 통과하고 `pod install`에서 실패합니다. 그래서 prebuild만 돌려 보면 문제를 놓칩니다.
- `expo run:ios`는 내부에서 `pod install --repo-update`를 다시 실행하는데, 이때 UTF-8 환경이 전달되지 않아 또 실패합니다.

가장 확실한 해결은 프로젝트를 ASCII 경로에 두는 것입니다. 경로를 바꿀 수 없다면 `pod install`을 따로 돌린 뒤 Expo CLI를 거치지 않고 빌드하세요.

```sh
(cd ios && pod install)
xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp \
  -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build build
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/MyApp.app
xcrun simctl launch booted com.example.myapp
```

공백이 있는 경로도 같은 부류의 문제를 냅니다. 이 저장소를 공백 없는 경로에서 개발하는 이유이기도 합니다.

### `babel-preset-expo` 버전이 SDK와 어긋날 때

번들링이 `private properties are not supported` 같은 Hermes 변환 오류로 실패합니다. preset은 쓰는 Expo SDK에 맞춰 고정하세요. 예를 들어 SDK 54에는 `babel-preset-expo@~54.0.12`를 씁니다. 이 저장소의 예제 앱은 Expo 57 기준입니다.

### 지도가 흰 화면으로 남을 때

웹 엔진은 `react-native-webview`가 함께 설치돼 있어야 하고, 네이티브 엔진(`engine="native"`)은 New Architecture development build가 필요합니다. Expo Go에서는 둘 다 동작하지 않습니다.

## 다음 단계

- [월드 데이터와 타일](./world-data): 내 동네 데이터 만들기
- [테마](./themes): 프리셋과 덮어쓰기
- [플레이그라운드](/playground/): 옵션을 바꾸며 JSX 복사하기
- [`MapramaViewProps` 레퍼런스](/api/reference/react-native/interfaces/MapramaViewProps)
