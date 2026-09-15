
(function(){
  const $ = s => document.querySelector(s);
  const api = window.__dk = window.__dk || {};
  let lang = 'swift';
  const tabs = ['style', 'move', 'items', 'players', 'fence', 'building'];

  function esc(s){ return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function hl(src){
    const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(import|let|val|var|try|await|in|true|false|nil|null)\b|\b(\d+(?:\.\d+)?f?)\b|\b([A-Z][A-Za-z0-9]*)\b/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index)); last = m.index + m[0].length;
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 'n' : 't';
      out += `<span class="${cls}">${esc(m[0])}</span>`;
    }
    return out + esc(src.slice(last));
  }
  const val = sel => { const el = document.querySelector(sel); return el ? el.value : null; };
  const checked = sel => { const el = document.querySelector(sel); return !!(el && el.checked); };
  const DEF_STYLE = { preset: 'realistic', time: 'day', facade: true, outline: false, shadows: true, cine: false, massing: 'box', lanes: true, crosswalks: true, props: true, parked: false, traffic: false };

  function snippet(tab){
    const S = lang === 'swift';
    if (tab === 'style') {
      const st = api.getStyle ? api.getStyle() : DEF_STYLE;
      const up = st.preset.toUpperCase(), tUp = st.time.toUpperCase();
      const facS = !st.facade ? '.plain' : st.preset === 'toy' ? '.windowGrid' : st.preset === 'soft' ? '.soft(roundness: 0.6)  // 둥근 매스·파스텔 창' : st.preset === 'urban' ? '.procedural(.auto)  // 다크 유리·금속 패널·그리드·노출 콘크리트' : st.preset === 'modern' ? '.procedural(.auto)  // 유리·밴드형·모던 주거·테라코타' : '.procedural(.auto)  // 유리·사무동·아파트·벽돌';
      const facK = !st.facade ? 'Facade.Plain' : st.preset === 'toy' ? 'Facade.WindowGrid' : 'Facade.Procedural(FacadeKind.AUTO)';
      const propsS = [st.props && '.trees', st.props && '.lamps', st.parked && '.parkedCars', st.parked && '.benches', st.parked && '.busStops'].filter(Boolean).join(', ');
      const propsK = [st.props && 'Prop.TREES', st.props && 'Prop.LAMPS', st.parked && 'Prop.PARKED_CARS', st.parked && 'Prop.BENCHES', st.parked && 'Prop.BUS_STOPS'].filter(Boolean).join(', ');
      return S ?
`// 프리셋 하나로 시작
let map = DioramaMapView(style: .${st.preset})${st.mapUi ? '\nmap.ui = [.locationPuck, .scaleBar, .zoomButtons, .attribution]' : ''}

// 필요한 것만 덮어쓰기
map.theme = .${st.preset}.with {
  $0.buildings.facade = ${facS}
  $0.buildings.outline = ${st.outline ? '.init(width: 1.5, color: .hex("#2A2540"))' : 'nil'}
  $0.buildings.details = ${st.details ? '[.slabEdges, .fins, .balconies, .canopies]' : '[]'}
  $0.buildings.massing = ${st.massing === 'varied' ? '.varied  // 포디움·계단식·ㄱ자·쌍둥이' : '.box'}${st.preset === 'urban' ? '\n  $0.buildings.heightScale = 1.6  // 스카이라인 강조' : ''}
  $0.lighting.timeOfDay = .${st.time}   // .auto 는 기기 시각을 따라감
  $0.lighting.grading = ${st.cine ? '.cinematic' : '.none'}
  $0.lighting.shadows = ${st.shadows ? '.soft' : '.off'}
  $0.roads.laneMarkings = ${st.lanes}
  $0.roads.crosswalks = ${st.crosswalks}
  $0.street.props = [${propsS}]
  $0.street.traffic = ${st.traffic ? '.ambient(density: 0.3)' : '.off'}
  $0.map.zoomOut = ${st.zoomOut === 'game' ? '.keepGameView(declutterFrom: 15)  // 높이·색 유지, 원경만 정리' : st.zoomOut === 'map' ? '.mapColors(buildingHeightScale: 0.4)' : '.none'}
  $0.map.labels = ${st.labels ? '[.districts, .roads, .pois]' : '[]'}
  $0.map.labelStyle = .${st.labelStyle || 'app'}${st.labelStyle === 'holo' ? '\n  $0.map.labelIcons = .' + (st.holoIcon || 'auto') + '  // 흰/검 타일 + 라인 아이콘' : ''}
}

${st.labelStyle === 'holo' ? (st.holoContent === 'custom' ? '// 표지판 내용: 라벨마다 앱이 직접 채움\nmap.labels.content = { label in\n  switch label.kind {\n  case .road:\n    return .init(title: label.name, subtitle: "내 위치에서 " + label.distanceText)\n  case .poi(let p) where p.category == .music:\n    return .init(title: p.name, subtitle: "오늘의 드롭 3곡", icon: .music)\n  default:\n    return .init(title: label.name)   // 이름만\n  }\n}\n\n' : '// 표지판 내용: .nameAndType / .nameOnly / .textOnly / .custom { }\nmap.labels.content = .' + ({ full: 'nameAndType', name: 'nameOnly', text: 'textOnly' })[st.holoContent || 'full'] + '\n\n') : ''}// 조건에 맞는 건물만 다른 외벽
map.theme.rules.add(
  where: .height(above: .meters(60)),
  facade: .texture("glass_tower.ktx2")
)` :
`// 프리셋 하나로 시작
val map = DioramaMapView(context, style = MapStyle.${up})${st.mapUi ? '\nmap.ui = setOf(MapUi.LOCATION_PUCK, MapUi.SCALE_BAR, MapUi.ZOOM_BUTTONS, MapUi.ATTRIBUTION)' : ''}

// 필요한 것만 덮어쓰기
map.theme = MapStyle.${up}.copy {
    buildings.facade = ${facK}
    buildings.outline = ${st.outline ? 'Outline(width = 1.5f, color = Color.parse("#2A2540"))' : 'null'}
    buildings.details = ${st.details ? 'setOf(Detail.SLAB_EDGES, Detail.FINS, Detail.BALCONIES, Detail.CANOPIES)' : 'emptySet()'}
    buildings.massing = ${st.massing === 'varied' ? 'Massing.VARIED' : 'Massing.BOX'}${st.preset === 'urban' ? '\n    buildings.heightScale = 1.6f' : ''}
    lighting.timeOfDay = TimeOfDay.${tUp}
    lighting.grading = ${st.cine ? 'Grading.CINEMATIC' : 'Grading.NONE'}
    lighting.shadows = ${st.shadows ? 'Shadows.SOFT' : 'Shadows.OFF'}
    roads.laneMarkings = ${st.lanes}
    roads.crosswalks = ${st.crosswalks}
    street.props = setOf(${propsK})
    street.traffic = ${st.traffic ? 'Traffic.Ambient(density = 0.3f)' : 'Traffic.OFF'}
    map.zoomOut = ${st.zoomOut === 'game' ? 'ZoomOut.KeepGameView(declutterFrom = 15f)' : st.zoomOut === 'map' ? 'ZoomOut.MapColors(buildingHeightScale = 0.4f)' : 'ZoomOut.NONE'}
    map.labels = ${st.labels ? 'setOf(Label.DISTRICTS, Label.ROADS, Label.POIS)' : 'emptySet()'}
    map.labelStyle = LabelStyle.${(st.labelStyle || 'app').toUpperCase()}${st.labelStyle === 'holo' ? '\n    map.labelIcons = LabelIcons.' + (st.holoIcon || 'auto').toUpperCase() : ''}
}

${st.labelStyle === 'holo' ? (st.holoContent === 'custom' ? '// 표지판 내용: 라벨마다 앱이 직접 채움\nmap.labels.content = LabelContent.Custom { label ->\n    when (val k = label.kind) {\n        is LabelKind.Road -> LabelView(label.name, subtitle = "내 위치에서 " + label.distanceText)\n        is LabelKind.Poi -> if (k.poi.category == PoiCategory.MUSIC)\n            LabelView(k.poi.name, subtitle = "오늘의 드롭 3곡", icon = Icon.MUSIC)\n            else LabelView(label.name)\n        else -> LabelView(label.name)\n    }\n}\n\n' : '// 표지판 내용: NAME_AND_TYPE / NAME_ONLY / TEXT_ONLY / Custom { }\nmap.labels.content = LabelContent.' + ({ full: 'NAME_AND_TYPE', name: 'NAME_ONLY', text: 'TEXT_ONLY' })[st.holoContent || 'full'] + '\n\n') : ''}map.theme.rules.add(
    where = BuildingFilter.heightAbove(60.meters),
    facade = Facade.Texture("glass_tower.ktx2")
)`;
    }
    if (tab === 'move') {
      if (val('input[name="ctrl"]:checked') !== 'route') return S ?
`import DioramaKit

let map = DioramaMapView(style: .realistic)
map.camera.pitchRange = 0...60

let hero = map.characters.add(
  model: .gltf("hero.glb"),
  at: .userLocation
)

// 튀는 GPS를 걸러내고 도로 위로 붙여서 걷게 하기
hero.follow(.deviceLocation(
  smoothing: .kalman,
  snapToRoads: true,
  rejectJumps: .meters(35)
))
hero.animations.autoGait = [.idle, .walk, .run]` :
`import dev.diorama.kit.*

val map = DioramaMapView(context, style = MapStyle.REALISTIC)
map.camera.pitchRange = 0f..60f

val hero = map.characters.add(
    model = Model.gltf("hero.glb"),
    at = Anchor.UserLocation
)

// 튀는 GPS를 걸러내고 도로 위로 붙여서 걷게 하기
hero.follow(
    DeviceLocation(
        smoothing = Smoothing.KALMAN,
        snapToRoads = true,
        rejectJumps = 35.meters
    )
)
hero.animations.autoGait = listOf(Gait.IDLE, Gait.WALK, Gait.RUN)`;
      const m = val('input[name="tmode"]:checked') || 'walk';
      const legsS = { walk: '[.walk]', bike: '[.bike(model: "bike.glb")]', car: '[.car(model: "car.glb")]', mixed: '[.walk, .car(model: "car.glb"), .walk]', plane: '[.plane(model: "plane.glb", cruiseAltitude: .meters(120))]', subway: '[.walk, .subway(stations: .nearest), .walk]' }[m];
      const legsK = { walk: 'listOf(Leg.Walk)', bike: 'listOf(Leg.Bike(model = "bike.glb"))', car: 'listOf(Leg.Car(model = "car.glb"))', mixed: 'listOf(Leg.Walk, Leg.Car(model = "car.glb"), Leg.Walk)', plane: 'listOf(Leg.Plane(model = "plane.glb", cruiseAltitude = 120.meters))', subway: 'listOf(Leg.Walk, Leg.Subway(stations = Stations.NEAREST), Leg.Walk)' }[m];
      return S ?
`// 목적지만 주면 기기 안에서 경로 탐색 + 이동 수단 연출
let dest = Coordinate(latitude: 37.5446, longitude: 127.0559)

let trip = try await map.routes.plan(
  from: hero.position,
  to: dest,
  legs: ${legsS}
)

map.overlays.show(trip, style: .route)
hero.travel(trip, playback: .realtime)  // 미리보기는 .fastForward

hero.onArrive { _ in
  map.overlays.remove(trip)
}` :
`// 목적지만 주면 기기 안에서 경로 탐색 + 이동 수단 연출
val dest = LatLng(37.5446, 127.0559)

val trip = map.routes.plan(
    from = hero.position,
    to = dest,
    legs = ${legsK}
)

map.overlays.show(trip, OverlayStyle.ROUTE)
hero.travel(trip, Playback.REALTIME)  // 미리보기는 FAST_FORWARD

hero.onArrive {
    map.overlays.remove(trip)
}`;
    }
    if (tab === 'items') {
      const type = api.getDropType ? api.getDropType() : 'coin';
      if (type === 'coin') return S ?
`let coins = spots.map { spot in
  DropItem(model: .gltf("coin.glb"), at: spot, value: 10)
}
map.drops.spawn(coins, entrance: .fallBounce(height: .meters(100)))
map.drops.idle = [.spin, .hover]

// 반경 15m 안에 들어오면 수집
map.drops.onCollect(radius: .meters(15), by: hero) { drop in
  wallet.add(drop.value)
}` :
`val coins = spots.map { spot ->
    DropItem(model = Model.gltf("coin.glb"), at = spot, value = 10)
}
map.drops.spawn(coins, entrance = Entrance.FallBounce(height = 100.meters))
map.drops.idle = listOf(Idle.SPIN, Idle.HOVER)

// 반경 15m 안에 들어오면 수집
map.drops.onCollect(radius = 15.meters, by = hero) { drop ->
    wallet.add(drop.value)
}`;
      const file = { cd: 'music_cd.glb', vinyl: 'vinyl_lp.glb', note: 'music_note.glb' }[type];
      return S ?
`// 음악 드롭: 모델·곡 데이터는 앱이, 배치·연출·수집 판정은 SDK가
let drops = nearbyTracks.map { track in
  DropItem(
    model: .gltf("${file}"),
    at: track.spot,
    payload: ["trackId": track.id],
    rarity: track.rarity            // .common / .rare / .legendary
  )
}
map.drops.spawn(drops, entrance: .fallBounce(height: .meters(100)))
map.drops.idle = [.spin, .hover, .beam(color: .byRarity), .particles("note.png")]

map.drops.onCollect(radius: .meters(15), by: hero) { drop in
  let track = catalog.track(id: drop.payload["trackId"])
  nowPlayingCard.show(track)
  collection.add(track)
}` :
`// 음악 드롭: 모델·곡 데이터는 앱이, 배치·연출·수집 판정은 SDK가
val drops = nearbyTracks.map { track ->
    DropItem(
        model = Model.gltf("${file}"),
        at = track.spot,
        payload = mapOf("trackId" to track.id),
        rarity = track.rarity           // COMMON / RARE / LEGENDARY
    )
}
map.drops.spawn(drops, entrance = Entrance.FallBounce(height = 100.meters))
map.drops.idle = listOf(Idle.SPIN, Idle.HOVER, Idle.Beam(BeamColor.BY_RARITY), Idle.Particles("note.png"))

map.drops.onCollect(radius = 15.meters, by = hero) { drop ->
    val track = catalog.track(drop.payload["trackId"])
    nowPlayingCard.show(track)
    collection.add(track)
}`;
    }
    if (tab === 'players') {
      const sil = checked('#sil');
      return S ?
`// 앱 서버의 위치 스트림 → SDK가 버퍼링 보간
map.characters.sync(with: playerStream) { snapshot in
  CharacterUpdate(
    id: snapshot.userID,
    position: snapshot.coordinate,
    heading: snapshot.heading
  )
}
map.characters.interpolation = .buffered(delay: .milliseconds(250))
map.characters.occlusion = ${sil ? '.silhouette(opacity: 0.9)' : '.none  // 건물 뒤에선 가려짐'}` :
`// 앱 서버의 위치 스트림 → SDK가 버퍼링 보간
map.characters.sync(playerStream) { snapshot ->
    CharacterUpdate(
        id = snapshot.userId,
        position = snapshot.latLng,
        heading = snapshot.heading
    )
}
map.characters.interpolation = Interpolation.Buffered(delay = 250.milliseconds)
map.characters.occlusion = ${sil ? 'Occlusion.Silhouette(opacity = 0.9f)' : 'Occlusion.None  // 건물 뒤에선 가려짐'}`;
    }
    if (tab === 'fence') return S ?
`let plaza = map.geofences.add(
  .circle(center: plazaCenter, radius: .meters(60))
)

plaza.onEnter(hero) { _ in
  map.buildings[plazaTowerID].state = "captured"
}
plaza.onExit(hero) { _ in analytics.log("plaza_exit") }

// 상태 이름 → 외관 규칙
map.theme.stateRules["captured"] = StateRule(
  glow: .hex("#FFD36E"),
  flag: .gltf("flag.glb")
)` :
`val plaza = map.geofences.add(
    Geofence.Circle(center = plazaCenter, radius = 60.meters)
)

plaza.onEnter(hero) {
    map.buildings[plazaTowerId].state = "captured"
}
plaza.onExit(hero) { analytics.log("plaza_exit") }

// 상태 이름 → 외관 규칙
map.theme.stateRules["captured"] = StateRule(
    glow = Color.parse("#FFD36E"),
    flag = Model.gltf("flag.glb")
)`;
    const b = api.getSelected ? api.getSelected() : null;
    const st = api.getStyle ? api.getStyle() : DEF_STYLE;
    const id = b ? b.id : 'osm:way/1002963';
    const floors = b ? Math.round(b.h*8/3) : 12;
    if (b && b.landmark) return S ?
`let tower = map.buildings["${id}"]

// 벡터 타일 건물 대신 직접 만든 모델로 통째로 교체
tower.replace(with: .gltf("cafe_tower.glb"), fit: .footprint)
tower.state = ${b.state === 'captured' ? '"captured"' : 'nil'}` :
`val tower = map.buildings["${id}"]

// 벡터 타일 건물 대신 직접 만든 모델로 통째로 교체
tower.replace(Model.gltf("cafe_tower.glb"), fit = Fit.FOOTPRINT)
tower.state = ${b.state === 'captured' ? '"captured"' : 'null'}`;
    const color = b ? (b.customColor || '#FFFFFF') : '#FFFFFF', roof = b ? b.effRoof : 'flat', win = b ? b.windows : true;
    const kind = b ? ((st.preset === 'urban' && b.ukey) || b.kind) : 'apartment', shape = b ? b.effShape : 'box';
    const decos = b ? b.decos : { sign: true, antenna: false, garden: false };
    const dS = [decos.sign && '.sign("GAME")', decos.antenna && '.antenna', decos.garden && '.trees(count: 3)'].filter(Boolean).join(', ');
    const dK = [decos.sign && 'Deco.Sign("GAME")', decos.antenna && 'Deco.Antenna', decos.garden && 'Deco.Trees(count = 3)'].filter(Boolean).join(', ');
    const cap = b && b.state === 'captured';
    const modern = st.preset === 'modern';
    const kS = (st.preset === 'urban' ? { glass: '.darkGlassCurtain', office: '.metalPanel', apartment: '.precastGrid', brick: '.exposedConcrete' } : modern ? { glass: '.glassCurtain', office: '.bandOffice', apartment: '.residentialModern', brick: '.terracotta' } : { glass: '.glassCurtain', office: '.office', apartment: '.apartment', brick: '.brick' })[kind];
    const kK = (st.preset === 'urban' ? { glass: 'DARK_GLASS_CURTAIN', office: 'METAL_PANEL', apartment: 'PRECAST_GRID', brick: 'EXPOSED_CONCRETE' } : modern ? { glass: 'GLASS_CURTAIN', office: 'BAND_OFFICE', apartment: 'RESIDENTIAL_MODERN', brick: 'TERRACOTTA' } : { glass: 'GLASS_CURTAIN', office: 'OFFICE', apartment: 'APARTMENT', brick: 'BRICK' })[kind];
    const mS = { box: '.box', podium: '.podium(towerRatio: 0.62)', setback: '.setback(tiers: 3)', L: '.lShape', twin: '.twinTowers(skybridge: true)' }[shape];
    const mK = { box: 'Massing.Box', podium: 'Massing.Podium(towerRatio = 0.62f)', setback: 'Massing.Setback(tiers = 3)', L: 'Massing.LShape', twin: 'Massing.TwinTowers(skybridge = true)' }[shape];
    return S ?
`let shop = map.buildings["${id}"]   // ${floors}층

shop.style = BuildingStyle(
  massing: ${mS},
  tint: .hex("${color}"),
  roof: ${{ flat: '.flat(parapet: true)', gable: '.gable(pitch: 0.42)', dome: '.dome' }[roof]},
  facade: ${win ? `.procedural(${kS})` : '.plain'},
  decorations: [${dS}]
)
shop.state = ${cap ? '"captured"' : 'nil'}` :
`val shop = map.buildings["${id}"]   // ${floors}층

shop.style = BuildingStyle(
    massing = ${mK},
    tint = Color.parse("${color}"),
    roof = ${{ flat: 'Roof.Flat(parapet = true)', gable: 'Roof.Gable(pitch = 0.42f)', dome: 'Roof.Dome' }[roof]},
    facade = ${win ? `Facade.Procedural(FacadeKind.${kK})` : 'Facade.Plain'},
    decorations = listOf(${dK})
)
shop.state = ${cap ? '"captured"' : 'null'}`;
  }

  let current = 'style';
  function renderCode(){
    $('#code').innerHTML = hl(snippet(current));
    $('#codeFile').textContent = lang === 'swift' ? 'GameMapViewController.swift' : 'GameMapActivity.kt';
  }
  function setTab(name){
    current = name;
    for (const t of tabs) {
      const on = t === name;
      $('#t-' + t).setAttribute('aria-selected', on ? 'true' : 'false');
      $('#t-' + t).tabIndex = on ? 0 : -1;
      $('#p-' + t).hidden = !on;
    }
    renderCode();
  }
  tabs.forEach((t, i) => {
    const el = $('#t-' + t);
    el.addEventListener('click', () => setTab(t));
    el.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      setTab(n); $('#t-' + n).focus();
    });
  });
  function setLang(l){
    lang = l;
    $('#langSwift').setAttribute('aria-pressed', l === 'swift'); $('#langKotlin').setAttribute('aria-pressed', l === 'kotlin');
    try { localStorage.setItem('dk-lang', l); } catch (e) {}
    renderCode();
  }
  $('#langSwift').addEventListener('click', () => setLang('swift'));
  $('#langKotlin').addEventListener('click', () => setLang('kotlin'));
  try { if (localStorage.getItem('dk-lang') === 'kotlin') lang = 'kotlin'; } catch (e) {}
  document.addEventListener('change', e => { if (e.target.closest && e.target.closest('.controls')) setTimeout(renderCode, 0); });
  document.querySelectorAll('[data-ls]').forEach(bt => bt.addEventListener('click', () => {
    if (window.__dk.setLabelStyle) window.__dk.setLabelStyle(bt.dataset.ls);
    if (bt.dataset.tod) { const r = document.querySelector('#tod-' + bt.dataset.tod); if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }
    setTab('style');
    const sp = document.querySelector('.specimen'); if (sp) sp.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  api.setTab = setTab; api.renderCode = renderCode;
  setLang(lang);
  setTab('style');
})();
