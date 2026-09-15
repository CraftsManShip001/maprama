---
layout: home
title: 홈
hero:
  name: Maprama
  text: 동네가 게임 맵이 되는 React Native 지도
  tagline: 실제 지도 위에 2.5D 건물, 걸어 다니는 캐릭터, 줍는 드롭, 홀로그램 라벨을 선언형 컴포넌트로 올리세요. 오른쪽 지도는 스크린샷이 아니라 실제 엔진이에요.
  actions:
    - theme: brand
      text: 시작하기
      link: /guide/getting-started
    - theme: alt
      text: 플레이그라운드
      link: /playground/
    - theme: alt
      text: 왜 이렇게 만들었나
      link: /guide/
features:
  - title: React Native 우선
    details: New Architecture(Fabric) 전용. bare RN과 Expo(config plugin) 모두 지원하고, 앱 코드는 컴포넌트와 ref, 훅만 씁니다.
    link: /guide/getting-started
    linkText: 설치
  - title: 바꿔 끼우는 엔진
    details: v1은 WebView 안의 three.js 엔진, v2는 MapLibre Native를 포크한 C++ 엔진. 둘은 같은 프로토콜을 말하므로 prop 하나로 전환합니다.
    link: /guide/architecture
    linkText: 구조와 로드맵
  - title: OSM + 국내 공공데이터
    details: OpenStreetMap에 국가공간정보포털 건물 높이를 붙여 월드를 만듭니다. Google 지도 데이터는 쓰지 않아요.
    link: /guide/world-data
    linkText: 월드 데이터
  - title: 테마 · 줌아웃 게임 뷰
    details: 6개 프리셋과 시간대, 시네마틱 그레이딩. 멀리 줌아웃해도 게임 느낌을 유지하는 keepGameView.
    link: /guide/themes
    linkText: 테마
  - title: 캐릭터 · 이동 · 드롭
    details: 어떤 glTF든 캐릭터로. 도보·자전거·자동차·비행기·지하철을 이어 붙인 이동, 서버가 검증하는 드롭 수집과 웹훅.
    link: /guide/drops
    linkText: 드롭과 검증
  - title: 오픈 코어
    details: SDK는 Apache-2.0 오픈소스. 월드·타일·검색·대중교통·드롭 검증은 API 키 기반 호스팅 서비스(무료 티어 제공)로.
    link: /service/
    linkText: 호스팅 서비스
---

<div class="mpr-section">

<h2>확정한 결정</h2>
<p class="sub">SDK 범위와 저장소 구성을 바꾼 결정들입니다. 자세한 이유는 <a href="./guide/">소개와 결정</a>에 있어요.</p>

<div class="mpr-grid">
  <div class="mpr-card"><span class="kicker">platform</span><h3>RN 우선, New Architecture 전용</h3><p>Fabric과 JSI 위에서만 동작합니다. RN 0.76+, iOS 15.1+, Android API 24+. 구 아키텍처 폴백은 없습니다.</p></div>
  <div class="mpr-card"><span class="kicker">expo</span><h3>Expo는 config plugin으로</h3><p>권한 문구와 기능 목록을 plugin이 네이티브 설정에 기록합니다. development build/prebuild에서 동작해요.</p></div>
  <div class="mpr-card"><span class="kicker">engine</span><h3>엔진은 교체 가능</h3><p>v1 WebView 엔진으로 먼저 출시하고, v2 네이티브 C++ 엔진이 같은 <code>@maprama/protocol</code> 메시지를 구현합니다.</p></div>
  <div class="mpr-card"><span class="kicker">data</span><h3>OSM + 국내 공공데이터</h3><p>OSM(ODbL)과 GIS건물통합정보 높이, 도로명주소를 씁니다. 출처 표기는 SDK가 기본으로 켭니다.</p></div>
  <div class="mpr-card"><span class="kicker">business</span><h3>오픈 코어</h3><p>SDK는 Apache-2.0. 호스팅 서비스는 API 키, 월 무료 할당량, 사용량 기반 초과 과금으로 운영합니다.</p></div>
  <div class="mpr-card"><span class="kicker">drops</span><h3>수집은 서버가 검증</h3><p>기기는 반경 판정으로 즉시 연출하고, 서비스가 거리·시간·순간이동을 검증해 서명된 영수증과 웹훅을 보냅니다.</p></div>
</div>

</div>

<div class="mpr-section">

<h2>SDK 안쪽 구조</h2>
<p class="sub">앱은 위 두 층만 만집니다. 엔진 층은 v1(WebView)과 v2(네이티브)가 같은 프로토콜로 바뀌어 들어갑니다.</p>

<div class="mpr-legend"><span><i class="new"></i>새로 만듦</span><span><i class="mod"></i>포크에서 수정 (v2)</span><span><i></i>그대로 사용</span></div>
<div class="mpr-stack">
  <div class="mpr-layer new"><div><h3>공개 API</h3><p class="sub">@maprama/react-native</p></div><div class="mpr-chips"><span>MapramaView</span><span>Character</span><span>CharacterLayer</span><span>DropLayer</span><span>Geofence</span><span>MapOverlay</span><span>useCharacterPosition</span><span>ref.travel()</span></div></div>
  <div class="mpr-layer new"><div><h3>프로토콜</h3><p class="sub">@maprama/protocol</p></div><div class="mpr-chips"><span>ThemeSpec</span><span>WorldData</span><span>EngineCommand</span><span>EngineEvent</span><span>encode/decode</span><span>createProjection</span></div></div>
  <div class="mpr-layer new"><div><h3>엔진 호스트</h3><p class="sub">WebView · JSI</p></div><div class="mpr-chips"><span>WebViewEngineHost (v1)</span><span>registerEngineHost</span><span>createMessageChannelHost</span></div></div>
  <div class="mpr-layer mod"><div><h3>렌더 엔진</h3><p class="sub">three.js (v1) · MapLibre Native 포크 + C++ 코어 (v2)</p></div><div class="mpr-chips"><span>건물 돌출 · 외벽 · 지붕</span><span>테마 · 시간대 조명</span><span>홀로 라벨</span><span>glTF 스키닝</span><span>인스턴싱 드롭</span><span>경로 · 도로 스냅</span></div></div>
  <div class="mpr-layer"><div><h3>데이터</h3><p class="sub">월드 · 타일 · 에셋</p></div><div class="mpr-chips"><span>WorldData JSON</span><span>PMTiles</span><span>maprama-osm</span><span>maprama (glTF)</span></div></div>
</div>

</div>

<div class="mpr-section">

<h2>엔진 로드맵</h2>
<p class="sub">v1 웹 엔진이 기준이고, 네이티브 엔진은 단계마다 같은 프로토콜 기능을 채웁니다. 목표 수치는 측정 전 추정치예요.</p>

<div class="mpr-milestones">
  <div class="mpr-card"><span class="tag">M0</span><h3>기반</h3><ul><li>설계 · C++ 인터페이스</li><li>JS와 동일한 JSON 코덱</li><li>프로토콜 적합성 테스트</li><li>MapLibre 패치 큐 도구</li></ul><p class="done">현재 단계</p></div>
  <div class="mpr-card"><span class="tag">M1</span><h3>지도가 화면에</h3><ul><li>Fabric 뷰 + JSI 모듈</li><li>init · 카메라 · 제스처</li><li>project / unproject</li></ul></div>
  <div class="mpr-card"><span class="tag">M2</span><h3>디오라마 룩</h3><ul><li>돌출 · 외벽 · 지붕 · 매스</li><li>테마 · 라벨 · 탭 판정</li><li>오버레이 앵커</li></ul></div>
  <div class="mpr-card"><span class="tag">M3</span><h3>게임 시스템</h3><ul><li>glTF 스키닝 캐릭터</li><li>이동 · 경로(A*, 지하철)</li><li>드롭 · 지오펜스</li></ul></div>
  <div class="mpr-card"><span class="tag">M4</span><h3>동등성과 성능</h3><ul><li>줌아웃 게임 뷰</li><li>기기 성능 · 메모리 측정</li><li><code>engine="native"</code> 베타</li></ul></div>
</div>

</div>
