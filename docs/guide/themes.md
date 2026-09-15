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

네이티브 엔진의 `keepGameView`는 먼 거리에서 건물을 합친 저해상도 지붕 임포스터로, 캐릭터와 드롭을 아이콘 스프라이트로 바꿔 드로 콜 예산을 지킬 계획입니다.

## 테마 JSON 내보내기

플레이그라운드의 **테마 JSON** 탭은 두 가지를 복사합니다.

- `ThemeSpec` 그대로: 앱의 `theme` prop에 붙여 넣으면 됩니다.
- **프리셋 객체 포함**: `base`에 프리셋 전체를 펼친 사용자 정의 테마. 팔레트나 조명 값을 직접 고칠 때 출발점으로 쓰세요. `validateThemePreset`으로 검증할 수 있습니다.

## 건물 하나만 바꾸기

테마는 전체 규칙이고, 특정 건물은 `ref.setBuildingStyle`로 덮어씁니다. [지오펜스와 건물](./geofences-buildings)을 보세요.
