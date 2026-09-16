# 테마

테마는 **프리셋 하나로 시작해서 필요한 값만 덮어쓰는** 방식입니다. `theme` prop이 바뀌면 `setTheme` 명령 하나가 엔진으로 갑니다.

```tsx
<MapramaView
  theme={{
    base: 'urban',
    timeOfDay: 'dusk',
    cinematic: true,
    buildings: { massing: 'varied', details: true },
    roads: { laneMarkings: true, crosswalks: true },
    street: { props: true, parked: false },
    zoomOut: 'keepGameView',
  }}
/>
```

[플레이그라운드](/playground/)에서 바꿔 보고 **테마 JSON**을 복사할 수 있어요.

## 프리셋

`PRESET_NAMES`: `realistic`(기본), `toy`, `minimal`, `modern`, `urban`, `soft`

| 프리셋 | 느낌 |
| --- | --- |
| `realistic` | 사실적인 외벽 텍스처와 표준 PBR 조명 |
| `toy` | 툰 셰이딩, 파스텔 팔레트, 창문 격자 |
| `minimal` | 외벽 없이 차분한 무채색 매스 |
| `modern` | 유리·밴드형 외벽, 평지붕, 진한 도로 |
| `urban` | 다크 유리와 금속 패널, 높이 강조 |
| `soft` | 둥근 인상의 파스텔 외벽 |

프리셋의 원본 데이터는 JSON으로도 배포됩니다.

```ts
import urban from '@maprama/protocol/themes/urban.json';
<MapramaView theme={{ base: urban, timeOfDay: 'night' }} />
```

## 옵션

| 필드 | 값 | 설명 |
| --- | --- | --- |
| `base` | 프리셋 이름 또는 [`ThemePreset`](/api/reference/protocol/interfaces/ThemePreset) 객체 | 시작점 |
| `timeOfDay` | `day` · `golden` · `dusk` · `night` | 조명, 안개, 하늘 그레이딩, 야간 창문 |
| `cinematic` | `boolean` | 시네마틱 컬러 그레이딩 |
| `shadows` | `boolean` | 실시간 그림자 |
| `buildings.facade` | `boolean` | 외벽 텍스처 |
| `buildings.outline` | `boolean` | 툰 스타일 외곽선 |
| `buildings.massing` | `box` · `varied` | 단순 돌출 또는 포디움·계단식 등 변형 매스 |
| `buildings.details` | `boolean` | 발코니, 실외기, 간판 같은 외벽 디테일 |
| `buildings.heightScale` | `number` | 높이 배율 (프리셋 값을 대체) |
| `roads.laneMarkings`, `roads.crosswalks` | `boolean` | 차선, 횡단보도 |
| `street.props`, `street.parked`, `street.traffic` | `boolean` | 가로등·표지판, 주차 차량·벤치·정류장, 주변 교통 |
| `zoomOut` | `none` · `mapColors` · `keepGameView` | 멀리 줌아웃했을 때의 동작 |

`varied` 매스는 건물 id 해시로 결정적으로 만들어지므로 웹 엔진과 네이티브 엔진이 같은 실루엣을 냅니다.

## 우선순위

`resolveTheme(spec)`이 모든 값을 확정합니다. 우선순위는 **spec 필드 → `PRESET_DEFAULTS[base]` → `BASE_THEME_DEFAULTS`** 입니다. 엔진은 이 결과만 봅니다.

```ts
import { resolveTheme } from '@maprama/protocol';

const t = resolveTheme({ base: 'toy', timeOfDay: 'night' });
t.buildings.massing; // 프리셋 기본값
t.time;              // TIMES.night (+ cinematic이면 CINE.night 병합)
```

## 줌아웃 동작

| 값 | 동작 |
| --- | --- |
| `none` | 어떤 거리에서도 디오라마를 그대로 둡니다 |
| `mapColors` | 멀어지면 평면 지도 색으로 바뀝니다. 길 찾기형 화면에 어울려요 |
| `keepGameView` | 높이와 색을 유지한 채 원경만 정리합니다. 게임 화면이 계속 게임처럼 보여요 |

두 엔진 모두 같은 밴드를 씁니다. 카메라 거리 55 월드 유닛부터 계수가 올라가 110 유닛에서 1이 되고, 그 사이를 부드럽게 오갑니다.

계수가 1이 된 뒤에도 카메라는 더 멀어질 수 있습니다([`maxDistanceMeters`](./camera#거리-한계는-미터입니다)). 150 유닛을 넘어서면 안개·그림자 범위가 `거리 / 150`배로 같이 늘어나므로, 3 km 뷰의 안개가 화면에서 1.2 km 뷰와 같은 위치에서 사라집니다. 150 유닛 이하에서는 배율이 정확히 1이라 이 문서의 값들이 그대로입니다.
네이티브 엔진은 여기에 두 가지 최적화를 더합니다. 계수가 0.5를 넘으면 커스텀 레이어가 외벽 디테일과 옥상 설비를 뺀 저디테일 범위를 그리고(웹 엔진이 거리에서 가로 소품을 숨기는 것과 같은 지점), 110 유닛을 넘으면 캐릭터와 드롭이 인스턴싱 드로 콜 하나짜리 아이콘 디스크로 바뀝니다. 웹 엔진은 이 거리에서도 3D 모델을 유지하므로, 아주 멀리서 본 캐릭터 모양이 두 엔진에서 유일하게 다릅니다.

## 테마 JSON 내보내기

플레이그라운드의 **테마 JSON** 탭은 두 가지를 복사합니다.

- `ThemeSpec` 그대로: 앱의 `theme` prop에 붙여 넣으면 됩니다.
- **프리셋 객체 포함**: `base`에 프리셋 전체를 펼친 사용자 정의 테마. 팔레트나 조명 값을 직접 고칠 때 출발점으로 쓰세요. `validateThemePreset`으로 검증할 수 있습니다.

## 건물 하나만 바꾸기

테마는 전체 규칙이고, 특정 건물은 `ref.setBuildingStyle`로 덮어씁니다. [지오펜스와 건물](./geofences-buildings)을 보세요.
