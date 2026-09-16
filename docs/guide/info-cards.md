# 정보 카드와 `focusOn`

정보 카드는 좌표 위 허공에 뜨는 **홀로그램 장소 카드**입니다. 지면의 점에서 빔이 올라가고, 그 끝에 상호명·카테고리·별점·상태 배지·상세 행·액션 버튼이 담긴 글래스 카드가 붙습니다. `holo` 라벨과 같은 시각 언어를 쓰고, 같은 DOM 레이어에 그려집니다.

::: warning 엔진은 카드를 스스로 열지 않습니다
탭 → 카메라 이동 → 카드 표시를 엔진이 자동으로 하지 않습니다. 엔진이 주는 것은 **원시 요소** 세 가지뿐입니다.

- 누름 이벤트(`MarkerLayer`의 `onPress`, `onPress` / `onBuildingPress`)
- 카메라를 옮기는 명령(`ref.focusOn`, `ref.setCamera`, `ref.fitBounds`)
- 카드를 그리는 선언(`<InfoCard>`)

이 셋을 어떤 순서로, 어떤 조건에서 엮을지는 앱이 정합니다. 아래 예제는 그 **한 가지 방법**을 보여줄 뿐이고, 라이브러리가 강제하는 흐름이 아닙니다.
:::

## 한 장 띄우기

```tsx
import { InfoCard, MapramaView, MarkerLayer } from '@maprama/react-native';

<InfoCard
  id="poi-3821"
  coordinate={{ lng, lat }}
  anchor="auto"          // 'ground' | 'roof' | 'auto'(기본): 좌표 아래 건물이 있으면 지붕
  heightMeters={12}      // 앵커 위로 뜨는 높이 (기본: 지면 30 m, 지붕 12 m)
  beam                   // 지면 점 + 리더 라인 (기본 true)
  dismissible            // 닫기 버튼 → onDismiss
  content={{
    title: '스타벅스 판교점',
    subtitle: '카페 · CAFE',
    icon: 'cafe',
    badges: [{ text: '영업 중', tone: 'good' }],
    rating: { value: 4.3, count: 1281 },
    rows: [
      { icon: 'hours', text: '22:00 영업 종료' },
      { icon: 'location', text: '성남시 분당구 …' },
      { icon: 'phone', text: '031-000-0000' },
    ],
    actions: [
      { id: 'route', label: '길찾기', primary: true },
      { id: 'call', label: '전화' },
    ],
  }}
  onPress={(e) => (e.actionId === 'route' ? startRoute() : undefined)}
  onDismiss={() => setOpen(null)}
/>
```

| prop | 뜻 |
| --- | --- |
| `id` | 카드 id. 지도 안에서 유일해야 합니다. `onPress` / `onDismiss`가 이 id를 돌려줍니다 |
| `anchor` | 빔이 시작하는 곳. `auto`(기본)는 좌표를 품는 건물이 있으면 지붕, 없으면 지면 |
| `heightMeters` | 앵커 위로 카드가 뜨는 높이(m). 기본값은 앵커 종류에 따라 다릅니다(지면 30 m, 지붕 12 m) |
| `content` | **구조화 스키마만** 받습니다(아래) |
| `beam` | 지면 점과 리더 라인. `false`면 카드만 뜹니다 |
| `dismissible` | 닫기 버튼을 보입니다. 누르면 `onDismiss`가 오고, **카드는 그대로 남습니다** |
| `onPress` | 카드 본체 또는 액션 버튼 누름. 버튼일 때만 `actionId`가 옵니다 |
| `onDismiss` | 닫기 버튼 누름. 카드를 지우는 건 앱의 몫입니다(언마운트하거나 상태를 비우세요) |

여러 장을 동시에 띄울 수 있습니다. 몇 장을 띄울지는 앱의 정책이지 엔진의 제약이 아닙니다.

### `content` 스키마

| 필드 | 뜻 |
| --- | --- |
| `title` | 상호명 (필수) |
| `subtitle` | 카테고리나 한 줄 설명 |
| `icon` | 장소 카테고리 아이콘. 라벨과 같은 집합(`cafe` `subway` `store` `music` `school` `book` `plaza` `park` `avenue` `street` `district` `water`) |
| `badges` | 짧은 상태 칩. `tone`은 `neutral`(기본) · `good` · `warn` · `bad` — **색이 아니라 역할**이라 테마가 칠합니다 |
| `rating` | `{ value, count? }`. 소수 한 자리로 표시합니다 |
| `rows` | 상세 행. `icon`은 `hours` `location` `phone` `link` `info` `price` |
| `actions` | 버튼. `{ id, label, primary? }`. `id`가 `onPress`의 `actionId`로 돌아옵니다 |

임의 HTML은 받지 않습니다. 이유는 셋입니다. 웹 엔진(DOM)과 네이티브 엔진(플랫폼 뷰)이 **같은 카드**를 그려야 하고, 스크린 리더가 **정해진 순서**로 읽어야 하며, 앱 데이터에서 온 마크업을 그대로 그리면 주입 구멍이 됩니다. 완전히 자유로운 렌더링이 필요하면 [`MapOverlay` + `ref.project`](./overlays-multiplayer.md)를 쓰세요. 그쪽은 앵커마다 화면 좌표를 브리지로 왕복시키므로 팬·줌 중에 밀리지만, 내용은 앱의 React 트리입니다.

## `ref.focusOn`

```ts
const result = await map.current.focusOn(
  { lng, lat },                 // 또는 { infoCardId: 'poi-3821' }
  {
    distance,        // m. 없으면 앵커와 카드 높이가 보이는 영역에 들어오는 거리를 엔진이 고릅니다
    pitch,           // 기본: 지금 값
    bearing,         // 기본: 지금 값 (지도가 멋대로 돌지 않습니다)
    heightMeters,    // 프레임에 담을 앵커 위 높이. `infoCardId`면 그 카드의 높이가 기본값
    animate,         // true | { durationMs } — 기본은 즉시
    inset,           // 기본 true — `ui.contentInset`을 존중합니다
  },
);
// { camera, fitted, distanceLimited }
```

`fitBounds`와 **같은 성격의 요청**입니다. 명령이 아닙니다.

- 카메라 거리 한계(`minDistanceMeters` / `maxDistanceMeters`)에 걸리면 한계 안에서 최선을 다하고 `distanceLimited: true`로 알려줍니다. 거부하지도, 조용히 어기지도 않습니다.
- `fitted`는 앵커와 `heightMeters`가 실제로 보이는 영역 안에 들어왔는지입니다.
- 도착하면 `camera:idle`이 `reason: 'api'`로 나갑니다.
- 나중 `focusOn`이 앞의 것을 **취소하지 않습니다**. 둘 다 resolve되고 카메라는 나중 것을 따릅니다 — `setCamera`를 두 번 부른 것과 같습니다.

`inset: true`(기본)면 바텀시트에 가려지는 영역을 피해 **보이는 영역** 안에 담습니다. 자세한 규칙은 [콘텐츠 인셋](./content-inset.md)을 보세요.

::: tip 카드 높이가 짧으면 거리는 최소값에 붙습니다
기본 지붕 카드(앵커 위 12 m)처럼 담아야 할 게 작으면, 기하학적으로 필요한 거리가 `minDistanceMeters`(기본 112 m)보다 가까워집니다. 그러면 최소 거리로 붙고 `distanceLimited: true`가 옵니다 — 이건 오류가 아니라 "더 갈 수 없어서 여기까지 왔다"는 보고입니다.
:::

## 엮는 방법 (예시일 뿐입니다)

```tsx
function PlaceMap({ places }: { places: Place[] }) {
  const map = useRef<MapramaViewRef>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = places.find((p) => p.id === openId) ?? null;

  const openPlace = async (place: Place) => {
    // 1. 카메라를 먼저 옮긴다 — 앱이 고른 각도로.
    const { fitted } = await map.current!.focusOn(place.coordinate, {
      pitch: 55,
      heightMeters: 30,
      animate: true,
    });
    if (!fitted) console.warn('거리 한계 때문에 다 담지 못했습니다');
    // 2. 도착한 뒤에 카드를 올린다. (먼저 올리고 나중에 옮겨도 됩니다 — 앱의 선택입니다.)
    setOpenId(place.id);
  };

  return (
    <MapramaView ref={map} world={world}>
      <MarkerLayer
        id="places"
        data={places}
        getId={(p) => p.id}
        getCoordinate={(p) => p.coordinate}
        selectedId={openId}
        onPress={(e) => void openPlace(places.find((p) => p.id === e.markerId)!)}
      />
      {open ? (
        <InfoCard
          id={open.id}
          coordinate={open.coordinate}
          dismissible
          content={open.content}
          onPress={(e) => e.actionId === 'route' && startRoute(open)}
          onDismiss={() => setOpenId(null)}   // 카드를 지우는 건 앱
        />
      ) : null}
    </MapramaView>
  );
}
```

같은 화면이 예제 앱의 **12. Info cards & focusOn**에 있습니다(`example/app/info-card.tsx`).

## 배치 규칙

카드는 **충돌에서 집니다 — 절대로**. 한 프레임의 순서는 이렇습니다.

1. 정보 카드를 먼저 배치하고, 카드 상자를 다음 두 패스의 제외 영역으로 넘깁니다.
2. 마커를 배치합니다(카드 상자를 피해서).
3. 라벨(DOM·holo)을 배치합니다(카드와 마커 상자를 피해서).

그래서 라벨이나 마커가 카드를 덮는 일은 없습니다. 카드가 많으면 주변 holo 라벨이 대부분 비켜서 사라지는데, 이건 의도한 우선순위입니다.

카드 자체는 숨겨지지 않고 **자리만 옮깁니다**.

- 화면 밖으로 밀리면 X축과 Y축 모두 **보이는 영역**(`ui.contentInset`을 뺀 영역) 안으로 클램프합니다. 그래서 바텀시트가 카드를 덮지 않습니다.
- 앵커가 카메라 뒤면 숨깁니다.
- 카메라가 멀어지면 축소하되, **300 m에서 1.0**을 기준으로 제곱근 감쇠하고 **0.78–1.15** 사이로 가둡니다. 0.78이면 13 px 제목이 약 10 px로 남습니다 — 휴대폰에서 한글이 읽히는 하한입니다. 위쪽 상한은 카메라 바로 아래의 카드가 포스터만 해지지 않게 합니다.
- 카드끼리는 서로 가리지 않습니다. 겹칠 때는 카메라 타깃에 가까운 카드가 위로 올라가서, 겹침이 깊이로 읽힙니다.

지붕 앵커는 매 프레임 건물 높이를 다시 읽습니다. 줌아웃 게임 뷰(`theme.zoomOut`)가 건물을 눌러도 빔의 발이 지붕에 붙어 있게 하기 위해서입니다.

## 접근성

카드 전체가 **하나의 접근성 요소**입니다. `role="group"`에 제목 → 부제 → 배지 → 별점 → 행 순서로 합성한 `aria-label`이 붙고, 본문 블록은 `aria-hidden`이라 같은 내용이 두 번 읽히지 않습니다. 액션 버튼과 닫기 버튼은 각각 진짜 `<button>`이라 따로 포커스되고 따로 눌립니다.

즉 스크린 리더는 "스타벅스 판교점, 카페 · CAFE, 영업 중, 4.3 (1281), 22:00 영업 종료, …"를 한 번에 읽은 뒤 "길찾기 버튼", "전화 버튼"으로 이동합니다.

## 성능

카드는 DOM으로 그립니다. three.js 메시가 아닙니다. 이유는 네 가지입니다.

- holo 라벨이 이미 DOM이라 겉모습이 픽셀 단위로 일관됩니다.
- 텍스트가 브라우저의 레이아웃·힌팅을 그대로 받습니다(캔버스 텍스처 리샘플이 없습니다).
- 스크린 리더가 읽을 수 있습니다.
- 레이아웃 비용이 렌더 루프 **바깥**에 있습니다.

마지막 항목이 중요합니다. 엔진은 [온디맨드 렌더링](./performance.md)이라, 아무것도 움직이지 않으면 프레임을 그리지 않습니다. 카드는 **등장·퇴장 전환 동안에만** 활성 소스를 잡고 끝나면 놓습니다. 그래서 카드가 떠 있고 카메라가 멈춰 있으면 유휴 프레임이 **0**입니다.

`packages/engine-web/scripts/idle-frames.mjs`로 측정한 값(2026-09-17, 정적 10초 × 2회, `realistic` 테마):

| 구성 | 프레임 |
| --- | --- |
| 카드 없음 | 0 |
| 카드 1장 | 0 |
| 카드 5장 | 0 |
| 카드 5장 + holo 라벨 | 0 |

## 네이티브 엔진

`@maprama/engine-native`는 이번 작업 범위 밖입니다. 네이티브 코어는 `setInfoCard` / `removeInfoCard` / `focusOn`을 **파싱하고 검증**하지만 그리지는 않습니다(명령은 경고 로그 후 무시, `focusOn`은 `unsupported` 응답). 네이티브 정보 카드 뷰는 로드맵의 잔여 항목입니다.
