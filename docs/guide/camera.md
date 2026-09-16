# 카메라

카메라는 지면의 한 점(`center`)을 바라보며 그 점에서 `distance`만큼 떨어져 있고, `pitch`(0 = 수직 내려보기, 최대 60°)와 `bearing`(북쪽 기준 시계방향)으로 방향을 잡습니다. 모든 값은 `camera` prop이나 `ref.setCamera`로 보냅니다.

```tsx
<MapramaView
  camera={{ center: STATION, distance: 400, pitch: 45, bearing: 0 }}
  ...
/>
```

## 거리 한계는 미터입니다

`minDistanceMeters` / `maxDistanceMeters`는 카메라가 타깃에서 가장 가까이·가장 멀리 갈 수 있는 거리를 **실제 미터**로 정합니다. 월드의 `unitMeters`와 무관합니다.

```tsx
<MapramaView
  camera={{
    center: STATION,
    minDistanceMeters: 60,     // 골목과 건물 정면까지 들어갈 수 있게
    maxDistanceMeters: 3330,   // 첫 화면에서 핀 18개가 다 들어오게
  }}
/>
```

기본값은 엔진의 14 / 150 월드 유닛입니다. 8 m/유닛인 월드라면 112 m ~ 1,200 m입니다. 즉 **`maxDistanceMeters`를 주지 않으면 지금까지와 똑같이** 동작합니다.

::: tip unitMeters로 해결하지 마세요
예전에는 더 멀리 보려고 `unitMeters`를 키웠습니다. 하지만 `unitMeters`는 월드 전체의 축척이라 모든 것이 같이 커집니다. 24 m/유닛이면 간선도로 폭이 72 m, 캐릭터 키가 45.6 m가 되고, **최소** 카메라 거리도 336 m가 되어 골목에 들어갈 수 없습니다. 거리 한계는 축척과 분리돼 있으니 `unitMeters`는 월드의 실제 축척 그대로 두세요.
:::

한계는 거리를 바꾸는 **모든 경로**에 걸립니다: `setCamera`(`distance`와 `zoom` 둘 다), 핀치, 휠, 줌 버튼, `follow`, 줌아웃 동작. 한계를 좁히면 현재 거리도 그 자리에서 끌려옵니다.

한계는 **한 번 주면 계속 유효**합니다. `camera` prop에 두면 값이 바뀔 때만 명령이 나가고, `ref.setCamera({ maxDistanceMeters })`로 언제든 바꿀 수 있습니다.

### 엔진이 감당하는 범위

엔진이 실제로 그릴 수 있는 범위는 **2 ~ 1,000 월드 유닛**입니다 (8 m/유닛이면 16 m ~ 8 km, 24 m/유닛이면 48 m ~ 24 km). 더 가까우면 카메라가 자기 절두체의 near 평면과 건물 안쪽에 들어가고, 더 멀면 깊이 버퍼가 도로 표시에서 z-파이팅을 일으킵니다.

이 범위를 벗어나는 값을 주면 엔진은 **좁혀서 적용하고**, `camera_limits_clamped` 코드의 **치명적이지 않은** `error` 이벤트를 한 번 보냅니다. 앱은 계속 동작하며, `onError`에서 요청값과 실제 적용값을 확인할 수 있습니다.

```tsx
onError={(e) => {
  if (e.code === 'camera_limits_clamped') console.warn(e.message);
}}
```

### 멀리서도 안개가 화면을 자르지 않습니다

안개(`fogNear` / `fogFar`)와 그림자 카메라 범위, 절두체의 near/far는 원래 150 유닛 상한에 맞춰 잡혀 있었습니다. 그대로 두고 카메라만 416 유닛(8 m/유닛에서 3,330 m)으로 내보내면 카메라가 안개 far 평면보다 **뒤에** 서게 되어 화면이 통째로 안개가 됩니다.

그래서 엔진은 이 범위들을 카메라 거리에 따라 함께 늘립니다.

- 150 유닛 이하에서는 배율이 정확히 1 — 지금까지 보던 그림이 한 자리도 바뀌지 않습니다.
- 그 위에서는 `거리 / 150`배 — 3 km 뷰의 안개가 화면에서 1.2 km 뷰와 **같은 위치**에서 사라집니다.

`theme.zoomOut`이 `'none'`이어도 마찬가지로 늘어납니다. 줌아웃 계수는 110 유닛에서 이미 1이 되므로, 그 위를 책임지는 것은 이 배율입니다.

멀리서 달라지는 것이 하나 있습니다: 라벨입니다. 동 이름은 40 유닛부터, 도로·POI 이름은 약 120 유닛까지만 나옵니다. 3 km 뷰에서는 동 이름만 남는데, 이게 넓은 화면에서 읽히는 모습입니다. 마커(`MarkerLayer`)에는 거리 컷오프가 없으니 핀은 전부 그려집니다(겹침 규칙은 [마커](./markers) 참고).

## 시야각과 "얼마나 보이나"

카메라의 수직 시야각은 **40°**입니다. 상수로 공개돼 있으니 직접 적어 넣지 마세요.

```ts
import { CAMERA_FOV_DEG, visibleSpanMeters } from '@maprama/react-native';

visibleSpanMeters(1200); // 874 m — 타깃에서 화면 세로로 보이는 지면 길이
```

`visibleSpanMeters(d) = 2 · d · tan(20°) ≈ 0.728 · d`입니다. 피치가 있으면 화면은 사다리꼴이라 지평선 쪽으로는 이보다 멀리까지 보이지만, `distance` ⇄ `zoom` 변환이 정의된 기준이자 "우리 동네가 화면에 들어오나"를 재는 값입니다.

## fitBounds: 상자를 화면에 맞추기

```tsx
const { fitted, camera } = await map.current.fitBounds(
  { sw: { lng: 127.04, lat: 37.53 }, ne: { lng: 127.08, lat: 37.57 } },
  { padding: { top: 80, right: 16, bottom: 160, left: 16 }, animate: true },
);
if (!fitted) {
  // 상자가 maxDistanceMeters로 담기지 않았습니다. 한계를 넓히거나 핀을 줄이세요.
}
```

- `padding`은 **dp**입니다. 숫자 하나면 네 변에 같이 적용되고, 변마다 따로 줄 수도 있습니다. 위에 헤더가, 아래에 바텀시트가 있는 화면이 정확히 이 모양입니다.
- `pitch` / `bearing`을 주면 그 방향으로 맞춥니다. 주지 않으면 `orientation`이 결정합니다.
- 결과는 **요청/응답**입니다. 엔진만 아는 것(뷰포트 dp 크기, 현재 피치, 거리 한계)으로 계산되고, "핀 18개가 정말 다 들어갔나"에 대한 답은 엔진만 할 수 있기 때문입니다. `setCamera`처럼 단방향으로 보내면 이 답을 받을 길이 없습니다.

| `orientation` | 동작 |
| --- | --- |
| `'auto'` (기본) | 현재 `pitch` / `bearing`으로 맞춰 보고, 그렇게 해서는 안 들어갈 때만 수직 내려보기 + 북쪽으로 바꿔 다시 맞춥니다 |
| `'keep'` | 현재 방향을 유지합니다. 안 들어가면 `fitted: false` |
| `'reset'` | 항상 `pitch: 0`, `bearing: 0` — 북향 상자를 가장 빡빡하게 담는 방향 |

`pitch`나 `bearing`을 명시하면 그건 지시이므로 `auto`의 되돌리기는 꺼집니다.

결과 필드:

| 필드 | 뜻 |
| --- | --- |
| `camera` | 엔진이 이동한 카메라 (`animate`를 줬다면 애니메이션이 끝나는 지점) |
| `fitted` | 상자 + padding이 화면 안에 전부 들어갔는가 |
| `distanceLimited` | 기하학이 요구한 거리가 `minDistanceMeters` / `maxDistanceMeters` 밖이어서 한계가 거리를 결정했는가 |

상자가 담기지 않아도 카메라는 **쓸 수 있는 상태**로 갑니다: 상자 중심에, 앱이 허용한 가장 먼 거리로. `fitted: false`를 받고 무엇을 할지는 앱이 정합니다.

::: warning 날짜변경선
`ne.lng < sw.lng`인 상자(태평양을 가로지르는 상자)는 지원하지 않습니다. 두 상자로 나눠 주세요. `ne.lat < sw.lat`도 거부됩니다.
:::

## 캐릭터 따라가기

`camera.follow`에 캐릭터 id를 주면 카메라 타깃이 그 캐릭터를 따라갑니다. `distance` / `pitch` / `bearing`은 그대로이고, 거리 한계도 그대로 적용됩니다. `null`을 보내거나 사용자가 팬하면 해제됩니다. 자세한 내용은 [캐릭터와 모델](./characters)에 있습니다.

## 예제

예제 앱의 **10. Camera limits & fitBounds** 화면이 이 문서를 그대로 보여줍니다: 기본 1,200 m 상한에서 핀 몇 개가 화면에 있는지 세고, `maxDistanceMeters`를 3,330 m로 올려 같은 장면을 다시 보고, `fitBounds`로 핀 18개를 한 번에 담습니다.
