# 지오펜스와 건물

## 지오펜스

원형 구역에 캐릭터가 들어가고 나갈 때 이벤트를 받습니다.

```tsx
<Geofence
  id="plaza"
  center={{ lng: 127.0565, lat: 37.5445 }}
  radiusMeters={60}
  onEnter={(e) => startQuest(e.characterId)}
  onExit={(e) => pauseQuest(e.characterId)}
/>
```

- 모든 `Geofence`는 프레임당 한 번의 `setGeofences` 명령으로 합쳐집니다 (전체 교체).
- 이벤트 `geofence:enter` / `geofence:exit`에는 `geofenceId`, `characterId`가 있습니다.
- 캐릭터와 중심 사이 거리가 반경보다 **작으면** 안쪽입니다.
- 목록을 바꿔도 남아 있는 지오펜스의 안/밖 상태는 유지되므로 `enter`가 중복으로 오지 않습니다.
- 지오펜스를 목록에서 빼거나 캐릭터를 제거하면 **`exit` 이벤트 없이** 조용히 잊습니다. 퀘스트 상태를 정리해야 한다면 앱이 직접 처리하세요.
- 월드가 로드되기 전에 보낸 지오펜스는 로드 후 적용되고, 새 월드를 로드하면 새 좌표계로 다시 배치됩니다.
- 드롭과 마찬가지로 보상과 연결된다면 서버에서 위치를 다시 확인하세요.

## 건물 탭

```tsx
<DioramaMap onBuildingPress={(e) => openBuildingSheet(e.buildingId, e.coordinate)} />
```

`buildingId`는 WorldData의 건물 id입니다 (`diorama-osm`으로 만든 월드는 `w<wayId>` 형식). 바닥을 탭하면 `onPress`가 옵니다.

## 건물별 스타일

테마는 전체 규칙이고, 건물 하나는 `setBuildingStyle`로 덮어씁니다.

```ts
map.current?.setBuildingStyle(buildingId, {
  color: '#FF8800',
  roof: 'gable',
  facade: false,
  decorations: ['sign', 'antenna'],
  massing: 'varied',
  state: 'captured',
});

map.current?.setBuildingStyle(buildingId, null); // 되돌리기
```

| 필드 | 값 | 설명 |
| --- | --- | --- |
| `color` | CSS hex | 색조 |
| `roof` | `flat` · `gable` · `dome` | 지붕 모양 |
| `facade` | `boolean` | 이 건물만 외벽 텍스처 켜기/끄기 |
| `decorations` | `sign` · `antenna` · `trees` | 장식 |
| `massing` | `box` · `varied` | 매스 |
| `replaceModel` | `{ uri }` | 돌출 건물 대신 glTF 랜드마크 |
| `state` | 문자열 | 앱 상태 (예: `captured`). 엔진 쪽 스타일 규칙에 사용 |

설정하지 않은 필드는 테마의 모습을 유지합니다.

## 예: 땅따먹기

```tsx
function Territory({ myTeamColor }: { myTeamColor: string }) {
  const map = useRef<DioramaMapRef>(null);
  return (
    <DioramaMap
      ref={map}
      world={world}
      onBuildingPress={async ({ buildingId }) => {
        const ok = await api.capture(buildingId); // 서버가 위치와 소유권을 검증
        if (ok) map.current?.setBuildingStyle(buildingId, { color: myTeamColor, decorations: ['sign'], state: 'captured' });
      }}
    >
      <Character id="me" isPlayer follow="location" />
      <Geofence id="hq" center={hq} radiusMeters={40} onEnter={() => api.checkIn('hq')} />
    </DioramaMap>
  );
}
```

## 네이티브 엔진에서는

건물 스타일은 건물 인덱스로 찾는 스타일 테이블 텍스처의 한 행으로 들어갑니다. 색이나 상태만 바뀌면 그 행만 업로드하고, 지붕·매스·`replaceModel`이 바뀔 때만 그 건물의 메시 청크를 다시 만듭니다. 탭 판정은 탭이 있는 프레임에만 ¼ 해상도 ID 패스로 합니다.
