# CLI 도구

데이터와 에셋은 오픈소스 CLI로 직접 만들 수 있습니다. 호스팅 서비스 없이도 SDK 전체를 쓸 수 있게 하는 부분이에요.

| 도구 | 패키지 | 하는 일 |
| --- | --- | --- |
| [`maprama-osm`](./osm) | `@maprama/osm` | OpenStreetMap(Overpass)과 국내 건물 높이로 `WorldData` JSON 생성 |
| [`maprama`](./assets) | `@maprama/assets` | glTF/GLB 모델 검사, 규칙 정규화, 최적화, 애니메이션 매핑 제안 |

두 도구 모두 먼저 프로토콜을 빌드해야 합니다.

```sh
npm run build -w @maprama/protocol
npm run build -w @maprama/osm
npm run build -w @maprama/assets
```
