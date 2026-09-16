# 소개와 결정

**Maprama**는 실제 동네 지도를 2.5D 게임 맵으로 바꾸는 React Native 라이브러리입니다. 건물은 테마에 맞춰 돌출되고, 캐릭터가 도로를 따라 걷고, 앱이 뿌린 아이템을 가까이 가서 줍고, 구역에 들어가면 이벤트가 옵니다.

::: tip 한눈에
- 앱 코드: `@maprama/react-native`의 컴포넌트, `ref` API, 훅
- 계약: `@maprama/protocol` (타입, 메시지 코덱, 좌표 투영, 테마 프리셋)
- 렌더링: 교체 가능한 엔진. v1은 `@maprama/engine-web`, v2는 네이티브 C++ 엔진
- 데이터와 검증: 오픈소스 CLI로 직접 만들거나, 유료 호스팅 서비스를 씁니다
:::

## 패키지 구성

| 패키지 | 역할 | 라이선스 |
| --- | --- | --- |
| `@maprama/react-native` | `MapramaView`과 자식 컴포넌트, ref API, 훅, Expo config plugin | Apache-2.0 |
| `@maprama/protocol` | 호스트와 엔진이 공유하는 계약: 타입, `encodeCommand`/`decodeEvent`, `createProjection`, 테마 프리셋 | Apache-2.0 |
| `@maprama/engine-web` | three.js 엔진 (v1). WebView 안이나 브라우저에서 실행 | Apache-2.0 |
| `@maprama/engine-native` | MapLibre Native 포크 + C++ 코어 (v2). 현재 설계와 코어 골격 단계 | Apache-2.0 |
| `@maprama/osm` (`maprama-osm`) | OSM과 국내 건물 높이로 `WorldData` JSON 생성 | Apache-2.0 (생성 데이터는 ODbL) |
| `@maprama/assets` (`maprama`) | glTF/GLB 검사·최적화 CLI | Apache-2.0 |
| 호스팅 서비스 (`@maprama/api`) | 월드·타일, 장소 검색, 대중교통, 드롭 검증, API 키, 웹훅 | 상용 |

## 확정한 결정과 그 이유

### React Native 우선, New Architecture 전용

게임 맵을 쓰려는 앱 대부분이 이미 RN으로 UI를 만들고 있어서, 네이티브 SDK를 먼저 만들고 RN 래퍼를 얹는 대신 **RN API를 먼저 확정**했습니다. Fabric과 JSI만 지원하면 v2 네이티브 엔진이 브리지 없이 JSI로 메시지를 주고받을 수 있습니다. 구 아키텍처는 지원하지 않습니다.

- RN 0.76+ (New Architecture 활성화), iOS 15.1+, Android API 24+
- `react` 18.3+ 또는 19, `react-native-webview` 13.12+

### Expo는 config plugin으로

Expo 앱은 development build나 prebuild로 씁니다. plugin이 위치 권한 문구와 사용할 기능 목록을 `Info.plist`와 `AndroidManifest.xml`에 기록합니다. v1 엔진은 기능 목록을 무시하지만, v2 네이티브 엔진은 이 목록으로 쓰지 않는 모듈을 뺄 계획입니다. [설치 가이드](./getting-started#expo)를 보세요.

### 엔진은 바꿔 끼운다

렌더러를 처음부터 네이티브로 만들면 출시가 늦어집니다. 그래서 **v1은 WebView 안의 three.js 엔진**으로 전체 기능을 먼저 제공하고, **v2는 MapLibre Native를 포크한 C++ 엔진**으로 성능과 배터리를 해결합니다. 두 엔진은 같은 `@maprama/protocol` 메시지(명령 20종, 이벤트 16종)를 구현하므로, 앱은 `engine` prop만 바꾸면 됩니다. [엔진 구조와 로드맵](./architecture)을 보세요.

### 데이터: OSM + 국내 공공데이터, Google 없음

- 도로, 건물 윤곽, POI, 물, 공원: **OpenStreetMap** (ODbL 1.0)
- 건물 높이와 층수: **국가공간정보포털 GIS건물통합정보** (선택)
- 주소 검색: **도로명주소 DB** (호스팅 서비스)

Google 지도 데이터는 약관상 다른 지도 위에 재가공할 수 없어서 쓰지 않습니다. 실제 데이터를 쓰는 앱은 `© OpenStreetMap contributors` 출처 표기를 반드시 보여야 하고, `ui.attribution`이 이를 그립니다. [월드 데이터와 타일](./world-data)을 보세요.

### 오픈 코어

SDK(컴포넌트, 프로토콜, 엔진, CLI)는 **Apache-2.0**으로 공개합니다. 누구나 `maprama-osm`으로 월드를 만들어 자기 CDN에 올릴 수 있습니다. 직접 운영하기 번거로운 부분은 **호스팅 서비스**가 API 키로 제공합니다.

- 월드 JSON과 PMTiles 벡터 타일, 장소 검색과 역지오코딩, 대중교통
- 동적 드롭 캠페인과 서버 검증 수집, 서명된 영수증, 웹훅
- 키마다 월 무료 할당량, pro 플랜은 초과분을 사용량으로 과금

자세한 내용은 [호스팅 서비스](/service/)에 있어요.

## 기능 지도

| 기능 | 어디서 | 가이드 |
| --- | --- | --- |
| 테마 프리셋 6종, 시간대, 시네마틱, 줌아웃 `keepGameView` | `theme` prop | [테마](./themes) |
| 홀로그램 라벨(아이콘 타일), 커스텀 라벨 내용 | `labels` prop | [라벨](./labels) |
| 어떤 glTF든 캐릭터, 다른 플레이어 레이어 | `Character`, `CharacterLayer` | [캐릭터와 모델](./characters) |
| 기기 GPS·외부 위치·시뮬레이션, 도보~비행기·지하철 이동 | `location` prop, `ref.travel` | [위치와 이동](./location-travel) |
| 드롭, 기기 판정 + 서버 검증 + 웹훅 | `DropLayer` | [드롭과 서버 검증](./drops) |
| 앱 소유 지도 핀: 고정 크기, 우선순위 충돌, 접근성, 부분 갱신 | `MarkerLayer` | [마커(핀)](./markers) |
| 좌표 위에 뜨는 홀로그램 장소 카드와 카메라 초점 이동 | `InfoCard`, `ref.focusOn` | [정보 카드와 focusOn](./info-cards) |
| 원형 지오펜스, 건물 탭과 건물별 스타일 | `Geofence`, `setBuildingStyle` | [지오펜스와 건물](./geofences-buildings) |
| 좌표에 붙는 RN 뷰, 멀티플레이 보간 | `MapOverlay`, `subscribe` | [오버레이와 멀티플레이](./overlays-multiplayer) |

직접 만져 보려면 [플레이그라운드](/playground/)로 가세요.
