# 라벨

엔진은 월드의 도로, 동·하천, POI 이름을 라벨로 그립니다. `labels` prop이 스타일과 내용을 정합니다.

```tsx
<DioramaMap labels={{ enabled: true, style: 'holo', icons: 'auto', content: 'nameAndType' }} />
```

`labels`에서 빠진 필드는 엔진 기본값을 씁니다: `enabled: true`, `style: 'holo'`, `icons: 'auto'`, `content: 'nameAndType'`. 그래서 아무것도 지정하지 않아도 홀로그램 라벨이 켜집니다. 끄려면 `enabled: false`를 넘기세요.

## 어떤 라벨이 생기나

월드가 로드될 때마다 엔진이 라벨 목록을 만들고 `labelsIndex` 이벤트로 보냅니다.

| 종류 | 만드는 규칙 | id |
| --- | --- | --- |
| `district` | WorldData `districts[]`의 동·하천 이름 | `district:<이름>` (같은 이름이 또 있으면 `#2`, `#3`…) |
| `road` | 이름 있는 도로(골목·다리 제외)를 따라 42 월드 단위마다 한 지점. 같은 이름끼리 30 단위 안에 겹치는 지점은 뺌 | `road:<도로 id>:<순번>` |
| `poi` | WorldData `pois[]` | `poi:<POI id>` |

id는 원본 데이터에서만 만들어지므로 같은 월드를 다시 로드해도 같습니다. 커스텀 내용의 키로 쓰세요.

## 스타일

`LABEL_STYLES`

| 값 | 모습과 표시 규칙 |
| --- | --- |
| `holo` (기본) | 바닥의 점에서 선이 올라가고 유리 카드가 떠오르는 홀로그램 표지판. 우선순위(동 → 간선도로 → POI → 일반 도로)와 화면 중심까지의 거리 순으로 겹치지 않게 놓고, 도로 카드는 화면에 최대 5개 |
| `app` | 지도 앱식 DOM 라벨. 카메라 거리에 따라 종류별로 보이고 숨습니다 (동 이름은 멀리서, 일반 도로 이름은 너무 멀지 않을 때) |
| `minimal` | `app`과 같은 배치에 작고 차분한 글씨. 간선이 아닌 도로 이름은 항상 숨기고, POI는 가까울 때만 보임 |
| `clean` | 깔끔한 텍스트. 멀어지면 간선이 아닌 도로 이름과 POI를 먼저 숨김 |
| `sticker` | 게임 HUD 같은 둥근 말풍선. 표시 규칙은 `app`과 같음 |
| `ground` | 도로와 동 이름을 바닥에 칠하고 POI는 핀으로 (3D) |
| `sign` | 이름 있는 교차로에 도로명판 기둥(최대 26개, 골목 이름 제외), 떠 있는 동 표지판, POI 핀 (3D) |

모든 스타일은 상태 표시줄 영역, 엔진 지도 UI(줌 버튼, 축척, 출처 표기), 화면 아래 여백을 피해서 배치됩니다.

## 홀로그램 아이콘 타일

`holo` 스타일에서 `icons`가 아이콘 타일 처리를 정합니다 (`HOLO_ICON_TILES`).

| 값 | 설명 |
| --- | --- |
| `auto` (기본) | 낮에는 흰 타일, 밤 조명에서는 검은 타일 |
| `white` | 흰 타일 + 라인 아이콘 |
| `black` | 검은 타일 + 라인 아이콘. 밤 테마와 어울림 |
| `color` | 카테고리 색 타일 |

아이콘은 POI 카테고리 8종과 `avenue`, `street`, `district`, `water`를 합친 12종(`LABEL_ICONS`)입니다.

## 내용

`content` (`LABEL_CONTENT_MODES`)

| 값 | 표시 |
| --- | --- |
| `nameAndType` (기본) | 이름 + 종류 부제목 + 아이콘 |
| `nameOnly` | 이름 + 아이콘 |
| `textOnly` | 이름만 |
| `custom` | 앱이 라벨마다 내용을 정함. 내용을 받지 못한 라벨은 `nameAndType`으로 표시 |

### 커스텀 내용

`content`에 함수를 넘기면 호스트가 엔진에 `content: 'custom'`을 보내고, 함수 결과를 `setLabelContent` 명령으로 보냅니다.

```tsx
const map = useRef<DioramaMapRef>(null);
const today = useTodayDrops(); // 앱 데이터

<DioramaMap
  ref={map}
  labels={{
    enabled: true,
    style: 'holo',
    content: (label) =>
      label.kind === 'poi' && label.category === 'music'
        ? { title: label.name, subtitle: `오늘의 드롭 ${today.count}곡`, icon: 'music' }
        : { title: label.name }, // null이나 undefined를 돌려주면 기본 이름 유지
  }}
/>

// 함수가 읽는 데이터가 바뀌면 다시 평가를 요청합니다
useEffect(() => map.current?.refreshLabelContent(), [today.count]);
```

함수는 **프레임마다 실행되지 않습니다.** 모든 라벨에 대해 다음 세 경우에만 평가됩니다.

1. 새 `labelsIndex`가 올 때 (엔진은 월드를 로드할 때마다 보냅니다)
2. `labels`에서 함수가 아닌 필드(예: `style`)가 바뀔 때
3. `ref.refreshLabelContent()`를 부를 때

항상 가장 최근 함수가 쓰이지만, **함수 identity만 바뀌어서는 다시 평가하지 않습니다.** 렌더마다 새로 만든 인라인 화살표 함수를 넘겨도 괜찮고, `useCallback`은 필요 없습니다. 대신 함수가 읽는 데이터가 바뀌면 `refreshLabelContent()`를 부르세요. 결과는 다음 프레임의 `setLabelContent`로 나갑니다.

- 인자 [`LabelInfo`](/api/reference/protocol/interfaces/LabelInfo)에는 `id`, `kind`(`road`/`district`/`poi`), `name`, `category`, `subtitle`, `lngLat`이 있습니다.
- 반환값 [`LabelContent`](/api/reference/protocol/interfaces/LabelContent)는 `title`, `subtitle?`, `icon?`입니다. `icon`이 없으면 라벨의 기본 아이콘을 씁니다.

## 프로토콜

| 방향 | 메시지 |
| --- | --- |
| 호스트 → 엔진 | `init.labels`, `setLabels { labels }`, `setLabelContent { entries }` |
| 엔진 → 호스트 | `labelsIndex { labels: LabelInfo[] }` (월드 로드마다, 그리고 목록이 바뀌었을 때) |

## 네이티브 엔진에서는

네이티브 엔진은 모든 스타일을 GPU 쿼드(SDF 글리프 + 아이콘 아틀라스)로 그릴 계획입니다. 3D 스타일(`holo`, `sign`, `ground`)은 깊이 테스트가 필요해서 네이티브 뷰로는 만들 수 없기 때문입니다. 접근성은 눈에 띄는 라벨 위치에 보이지 않는 접근성 요소를 최대 30개 배치해 보완합니다. 상호작용이 필요한 풍부한 UI는 [`MapOverlay`](./overlays-multiplayer)를 쓰세요.
