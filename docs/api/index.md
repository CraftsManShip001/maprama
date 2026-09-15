# API 레퍼런스

아래 레퍼런스는 소스의 TSDoc 주석에서 [TypeDoc](https://typedoc.org)으로 **빌드할 때마다 생성**됩니다. 설명은 영어 원문 그대로입니다. 개념 설명은 [가이드](/guide/)를 보세요.

## 패키지

### [`@diorama/react-native`](/api/reference/react-native/)

앱이 쓰는 API입니다.

- 컴포넌트: [`DioramaMap`](/api/reference/react-native/variables/DioramaMap), [`Character`](/api/reference/react-native/functions/Character), [`CharacterLayer`](/api/reference/react-native/functions/CharacterLayer), [`DropLayer`](/api/reference/react-native/functions/DropLayer), [`Geofence`](/api/reference/react-native/functions/Geofence), [`MapOverlay`](/api/reference/react-native/functions/MapOverlay)
- props: [`DioramaMapProps`](/api/reference/react-native/interfaces/DioramaMapProps), [`CharacterProps`](/api/reference/react-native/interfaces/CharacterProps), [`DropLayerProps`](/api/reference/react-native/type-aliases/DropLayerProps)
- ref: [`DioramaMapRef`](/api/reference/react-native/interfaces/DioramaMapRef)
- 훅: [`useDioramaMap`](/api/reference/react-native/functions/useDioramaMap), [`useCharacterPosition`](/api/reference/react-native/functions/useCharacterPosition), [`useCameraState`](/api/reference/react-native/functions/useCameraState)
- 엔진 호스트: [`EngineHost`](/api/reference/react-native/interfaces/EngineHost), [`registerEngineHost`](/api/reference/react-native/functions/registerEngineHost), [`createMessageChannelHost`](/api/reference/react-native/functions/createMessageChannelHost)
- 오류: [`DioramaError`](/api/reference/react-native/classes/DioramaError)

### [`@diorama/protocol`](/api/reference/protocol/)

호스트와 엔진이 공유하는 계약입니다. 앱에서는 주로 타입과 테마 프리셋을 가져다 씁니다.

- 테마: [`ThemeSpec`](/api/reference/protocol/interfaces/ThemeSpec), [`resolveTheme`](/api/reference/protocol/functions/resolveTheme), [`PRESETS`](/api/reference/protocol/variables/PRESETS)
- 월드: [`WorldData`](/api/reference/protocol/interfaces/WorldData), [`WorldSource`](/api/reference/protocol/type-aliases/WorldSource), [`validateWorldData`](/api/reference/protocol/functions/validateWorldData)
- 좌표: [`createProjection`](/api/reference/protocol/functions/createProjection), [`haversineMeters`](/api/reference/protocol/functions/haversineMeters)
- 메시지: [`EngineCommand`](/api/reference/protocol/type-aliases/EngineCommand), [`EngineEvent`](/api/reference/protocol/type-aliases/EngineEvent), [`encodeCommand`](/api/reference/protocol/functions/encodeCommand), [`decodeEvent`](/api/reference/protocol/functions/decodeEvent)

`@diorama/react-native`가 다시 내보내는 프로토콜 타입(`ThemeSpec`, `LngLat` 등)은 프로토콜 페이지로 연결됩니다.

## 그 밖의 레퍼런스

- 호스팅 서비스 HTTP API: [OpenAPI 레퍼런스](/service/api-reference)
- CLI: [diorama-osm](/tools/osm), [diorama](/tools/assets)
- 엔진 메시지 흐름과 호환성 규칙: [엔진 구조와 로드맵](/guide/architecture)
