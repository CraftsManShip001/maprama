# 오버레이와 멀티플레이

## `MapOverlay`: 좌표에 붙는 RN 뷰

가게 카드, 말풍선, 버튼처럼 상호작용이 필요한 UI는 엔진이 아니라 React Native 뷰로 그리고 지도 좌표에 붙입니다.

::: tip 핀 수십 개라면 `MarkerLayer`
앵커마다 화면 좌표가 브리지를 왕복하므로 `MapOverlay`는 소수의 카드에 맞습니다. 서버에서 받은 POI 핀처럼 수십 개를 얹을 때는 [마커(핀)](./markers)를 쓰세요. 엔진이 직접 그려서 팬 중에도 밀리지 않고, 충돌·z 순서·접근성·부분 갱신을 함께 처리합니다.
:::

```tsx
<MapramaView world={world}>
  <MapOverlay coordinate={shop.coord} anchor="bottom" offset={{ x: 0, y: -8 }} hideWhenOffscreen>
    <Pressable onPress={() => openShop(shop.id)}>
      <ShopCard shop={shop} />
    </Pressable>
  </MapOverlay>
</MapramaView>
```

| prop | 설명 |
| --- | --- |
| `coordinate` | 붙일 좌표 |
| `anchor` | 뷰의 어느 점이 좌표에 오는지. `center`, `top`, `bottom`(기본), `left`, `right`, 네 모서리 |
| `offset` | 앵커 후 추가 이동 (dp) |
| `hideWhenOffscreen` | 화면 밖이면 숨김. 기본 `true` |
| `id` | 앵커 id. 없으면 자동 생성 |

동작 방식: 호스트가 `setOverlayAnchors`로 앵커 좌표를 보내고, 엔진이 `overlay:positions` 이벤트로 화면 위치를 돌려줍니다. 호스트는 이 값을 `Animated` 값에 적용하므로 **카메라가 움직여도 React가 다시 렌더링되지 않습니다.**

한 번만 좌표 ↔ 화면 변환이 필요하면 요청 API를 쓰세요.

```ts
const pt = await map.current!.project(coordinate);      // { x, y, visible }
const ground = await map.current!.unproject({ x, y });  // LngLat | null
```

## 멀티플레이

SDK의 범위는 **클라이언트 쪽**입니다. 다른 플레이어를 `CharacterLayer`로 그리고, 건물에 가려지면 실루엣으로 보여 줍니다. 위치를 주고받는 서버는 앱이 고릅니다 (Firebase, Supabase Realtime, 자체 WebSocket 등).

::: tip 위치는 보간되지 않습니다
`getPosition` 값이 바뀌면 엔진은 캐릭터를 그 위치로 **순간이동**시킵니다. 스냅샷이 드문드문 온다면 앱에서 이전 위치와 새 위치 사이를 보간한 값을 넘기세요. 프레임마다 값이 바뀌어도 명령은 프레임당 한 번으로 묶입니다.
:::

```tsx
function World({ roomId }: { roomId: string }) {
  const map = useRef<MapramaViewRef>(null);
  const players = useRoomPlayers(roomId); // 앱의 실시간 스트림: { id, coord, avatarUrl, name }[]

  // 내 위치는 throttle해서 서버로
  useEffect(() => map.current?.subscribe('character:position', (e) => sendMyPosition(roomId, e), { id: 'me', throttleMs: 1000 }), [roomId]);

  return (
    <MapramaView ref={map} world={world} location={{ source: 'device' }}>
      <Character id="me" isPlayer follow="location" />
      <CharacterLayer
        data={players}
        getId={(p) => p.id}
        getPosition={(p) => p.coord}
        getModel={(p) => p.avatarUrl}
        getName={(p) => p.name}
        showNameTags
      />
    </MapramaView>
  );
}
```

- `CharacterLayer`의 변경은 프레임당 한 번의 `upsertCharacters`/`removeCharacters`로 묶입니다. 스트림이 초당 수십 번 와도 명령은 늘지 않아요.
- 내 위치 전송 주기는 `subscribe`의 `throttleMs`로 조절합니다. 게임 상태가 아닌 곳에서는 1초 이상을 권장합니다.
- 여러 컴포넌트가 같은 토픽을 구독해도 엔진 구독은 하나로 공유됩니다.
- `useCharacterPosition` / `useCameraState`는 지도가 훅보다 늦게 마운트되어도 마운트되는 순간 구독하고, 다른 지도로 바뀌면 `null`로 초기화한 뒤 새 지도를 구독합니다.
- 캐릭터를 제거하면 그 캐릭터의 지오펜스 `exit` 이벤트는 오지 않습니다.

## 이벤트를 직접 듣기

```ts
const off = map.current!.addEventListener('building:press', (e) => console.log(e.buildingId));
```

`addEventListener`는 모든 엔진 이벤트 종류를 받을 수 있고, 해제 함수를 반환합니다.
