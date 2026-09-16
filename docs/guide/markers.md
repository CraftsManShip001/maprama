# 마커(핀)

마커는 **앱이 소유하고 엔진이 그리는 지도 핀**입니다. 화면상 크기가 고정이고, 핀 끝이 좌표에 붙고, 라벨과 같은 충돌 패스를 쓰며, 접근성 노드를 가집니다.

서버에서 받은 POI 수십 개를 지도에 얹는 일이라면 `MapOverlay` 대신 `MarkerLayer`를 쓰세요. `MapOverlay`는 앵커마다 화면 좌표를 브리지로 왕복시키므로 팬·줌 중에 밀리고, 충돌 처리나 z 순서가 없습니다. `MarkerLayer`는 마커 목록이 바뀔 때만 명령을 보내고, 프레임마다 하는 일은 전부 엔진 안에서 끝납니다.

## 기본 사용

```tsx
<MarkerLayer
  id="poi"
  data={pois}
  getId={(p) => p.id}
  getCoordinate={(p) => p.coord}
  getIcon={(p) => ({ uri: p.iconSvg })}      // 'pin' | 'dot' | data:image/svg+xml | https://…
  getColor={(p) => FACTION[p.faction]}       // 기본 도형을 이 색으로 틴트
  getPriority={(p) => p.rank}                // 클수록 충돌에서 이김
  getAlwaysVisible={(p) => p.partner}        // 충돌로 절대 숨기지 않음
  getAccessibilityLabel={(p) => `${p.title}, ${p.faction}`}
  selectedId={selected}
  selectedScale={1.25}
  size={36}                                  // dp (핀 높이)
  anchor="bottom"                            // 핀 끝이 좌표 위 (기본)
  onPress={(e) => openSheet(e.markerId, e.point)}
/>
```

| prop | 뜻 |
| --- | --- |
| `id` | 레이어 id. 지도 안에서 유일해야 합니다. 여러 레이어를 동시에 둘 수 있습니다 |
| `getIcon` | `'pin'`(기본 물방울)·`'dot'`(원) 중 하나이거나, 기본 도형 **안에** 얹을 이미지(`{ uri }`, URI 문자열, `require()` 에셋). `data:image/svg+xml`과 `https:` 모두 됩니다 |
| `getColor` | 기본 도형의 틴트 색(CSS hex). 아이콘 이미지는 그대로 둡니다 |
| `getPriority` | 충돌 우선순위. 기본 0 |
| `getAlwaysVisible` | `true`면 충돌·HUD 영역과 무관하게 항상 그립니다 |
| `getAccessibilityLabel` | 스크린 리더가 읽는 문구. 없는 마커는 접근성 트리와 탭 순서에서 빠집니다 |
| `selectedId` | 선택된 마커. `selectedScale`만큼 커지고 **절대 숨겨지지 않습니다**. `null`이면 선택 없음 |
| `size` | 핀 높이(dp). 기본 36. 카메라 거리와 무관하게 화면상 크기가 고정입니다 |
| `anchor` | `bottom`(기본, 핀 끝이 좌표 위)·`center`·`top` |

## 충돌과 순서

마커는 라벨보다 **먼저** 배치되고, 배치된 마커의 박스는 라벨 배치의 제외 영역이 됩니다. 한 프레임의 순서는 이렇습니다.

1. HUD 제외 영역(상태 바, 스케일 바·줌 버튼·저작자 표시, 화면 아래 여백)을 먼저 예약합니다.
2. **절대 숨기지 않는 마커** — `getAlwaysVisible`이 `true`이거나 `selectedId`인 마커 — 를 우선순위 순으로 배치합니다. 이 마커들은 HUD 영역이나 다른 마커와 겹쳐도 그려지고, 자기 박스를 예약합니다.
3. 나머지 마커를 `priority` 내림차순 → 카메라 타깃까지의 거리 오름차순 → id 순으로 배치합니다. 이미 예약된 박스와 겹치지 않을 때만 그립니다.
4. 마지막으로 라벨(DOM·holo)을 배치합니다. 앞의 박스들이 제외 영역이므로 **라벨이 마커를 덮는 일은 없습니다.**

즉 마커는 라벨보다 항상 우선하고, 마커들 사이에서는 `alwaysVisible`·선택 → `priority` → 카메라 근접 순으로 이깁니다. 관광 앱처럼 "제휴 핀과 선택된 핀은 절대 사라지면 안 된다"는 요구는 2번 규칙이 보장합니다.

## 부분 갱신 (색·선택만 바꾸기)

엔진은 마커를 **id로 매칭**합니다. 같은 id가 계속 오면 뷰를 다시 만들지 않고 바뀐 필드만 씁니다.

- `color`만 바뀌면 CSS 변수 하나를 씁니다. **아이콘을 다시 읽지 않습니다.**
- `selectedId`만 바뀌면 클래스 하나와 변환의 배율만 바꿉니다.
- 좌표가 바뀌면 다음 프레임의 화면 위치만 달라집니다.
- 목록에서 빠진 마커의 뷰는 버리지 않고 풀에 넣었다가 다음에 재사용합니다.

호스트 쪽도 같은 정신입니다. `MarkerLayer`는 레이어 상태가 직전에 보낸 것과 다를 때만 `setMarkerLayer`를 보내고, 프레임당 레이어마다 최대 한 번만 보냅니다. 같은 데이터로 리렌더하면 브리지에 아무것도 흐르지 않습니다.

```tsx
// 45초마다 서버가 색과 선택만 바꿔 주는 경우: 목록은 그대로 두고 색만 갈아 끼웁니다.
const [palette, setPalette] = useState(DAY);
const [selected, setSelected] = useState<string | null>(null);
// pois는 그대로 — 마커가 다시 만들어지지 않으므로 깜빡임도, 아이콘 재요청도 없습니다.
```

::: tip 마커를 새로 만들지 마세요
다른 지도 라이브러리처럼 "마커를 지웠다 다시 추가"할 필요가 없습니다. `data`의 항목 id를 유지한 채 색·선택만 바꾸면 됩니다. id가 바뀌면 엔진은 다른 마커로 보고 뷰를 새로 만듭니다.
:::

## 탭과 화면 좌표

```tsx
onPress={(e) => {
  // e.layerId, e.markerId, e.coordinate, e.point {x, y}
  openBottomSheet(e.markerId, e.point);
}}
```

`e.point`는 마커 **앵커**의 화면 좌표(dp)입니다. `anchor="bottom"`이면 핀 끝, 즉 좌표가 찍힌 지점입니다. 시트나 팝오버를 그 자리에 띄우면 됩니다.

**우선순위:** 보이는 마커를 누른 탭은 `marker:press`만 발생시킵니다. 같은 탭에 대해 지도의 `onPress`(지면)나 `onBuildingPress`(건물)는 **호출되지 않습니다.** 엔진이 건물·지면을 찍기 전에 마커를 먼저 히트 테스트하기 때문입니다. 충돌로 숨겨진 마커는 눌리지 않습니다.

## 접근성

마커 카드는 `aria-label`을 가진 버튼입니다(웹 엔진에서는 DOM `<button>`). 스크린 리더는 `getAccessibilityLabel`이 돌려준 문구를 그대로 읽고, 선택된 마커에는 `aria-current="true"`가 붙습니다. 키보드(Enter/Space)나 보조 기술로 활성화해도 `onPress`가 같은 페이로드로 호출됩니다.

`getAccessibilityLabel`을 주지 않은 마커는 장식으로 보고 접근성 트리와 탭 순서에서 제외합니다. 사람이 누를 수 있는 핀에는 항상 라벨을 주세요.

## 성능

- 마커는 라벨과 같은 뷰 풀을 씁니다. 두 번째 GPU 렌더러가 생기지 않고, 배치도 한 번만 돕니다.
- 팬·줌 중에 RN 쪽에서 하는 일은 **없습니다.** 투영·충돌·변환은 모두 엔진 안에서 끝납니다.
- 마커 60개 정도는 프레임 예산에 의미 있는 영향을 주지 않습니다([성능](/guide/performance) 참고).
- `data`와 getter가 가리키는 값이 그대로면 명령도 나가지 않습니다. getter 자체를 `useCallback`으로 감쌀 필요는 없습니다(결과 값만 비교합니다).

## 지금 웹 엔진 전용

마커는 기본 WebView 엔진(`@maprama/engine-web`)에서 동작합니다. `engine="native"`로 띄운 네이티브 엔진은 `setMarkerLayer` / `removeMarkerLayer`를 검증한 뒤 경고 로그만 남기고 무시합니다(네이티브 마커 뷰는 다음 마일스톤). 네이티브 엔진에서 핀이 필요하면 그때까지는 `MapOverlay`를 쓰세요.
