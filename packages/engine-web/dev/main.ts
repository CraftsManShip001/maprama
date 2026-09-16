/**
 * engine-web playground. Hash parameters (all optional):
 *
 * `layout=grid|town|sample` · `preset=realistic|toy|minimal|modern|urban|soft` ·
 * `tod=day|golden|dusk|night` · `cine=0|1` · `zo=none|mapColors|keepGameView` ·
 * `dist` (world units) · `pitch` · `bearing` · `x`,`z` (world units center) ·
 * `massing=box|varied` · `details=0|1` · `facade=0|1` · `outline=0|1` ·
 * `shadows=0|1` · `lanes=0|1` · `crosswalks=0|1` · `props=0|1` · `parked=0|1` ·
 * `panel=0` (hide controls) · `frames` (frames to render before signalling ready) ·
 * `world=<url>` (WorldData JSON for `layout=sample`, default `./sample-world.json`).
 *
 * Part 2: `labels=off|app|minimal|clean|sticker|ground|sign|holo` (default off) ·
 * `icons=auto|white|black|color` · `content=nameAndType|nameOnly|textOnly|custom`
 * (custom sends sample `setLabelContent`) · `ui=1` (puck, scale bar, zoom
 * buttons, attribution) · `player=1` · `loc=simulated|external|device` ·
 * `travel=walk|bike|car|plane|subway|mixed` (adds the player, follows it,
 * travels and signals ready in the middle of the plane / subway / vehicle
 * leg) · `drops=coin|cd|vinyl|note` (drop layer around the view center) ·
 * `settle=<ms>` (extra wait before ready, e.g. for label pop-in) ·
 * `model=<url>` (glTF / GLB model for the player; ready waits until it is
 * attached, e.g. `/fixtures/box-character.glb`) ·
 * `cards=<n>` (holographic info cards on the POIs nearest the view centre) ·
 * `cardAnchor=ground|roof|auto` (default `auto`) · `cardsOn=poi|building` (what the
 * cards sit on; `building` demonstrates the roof anchor) · `focus=1` (`focusOn` the
 * first card after showing it, as an app would after a press) ·
 * `inset=<px>` (bottom `ui.contentInset`, as an app sheet would set) ·
 * `markers=<n>` (app-owned pins on the POIs nearest the view centre) ·
 * `markerAnchor=ground|roof` (default `ground`, the engine default) ·
 * `markerSnap=0|1` (opt into `snapToBuilding`; default 0).
 *
 * Sets `window.__MAPRAMA_READY__ = true` once the world is loaded and rendered
 * (used by `scripts/screenshot.mjs`); engine `error` events are logged with
 * `console.error`.
 */

import type {
  DropSpec,
  DropType,
  EngineCommand,
  InfoCardAnchor,
  InfoCardSpec,
  MarkerAnchorHeight,
  MarkerSpec,
  EngineEvent,
  HoloIconTile,
  LabelContent,
  LabelContentMode,
  LabelInfo,
  LabelsSpec,
  LabelStyle,
  LocationSourceKind,
  MapUiSpec,
  PresetName,
  Rarity,
  ThemeSpec,
  TimeOfDay,
  TravelMode,
  WorldData,
  WorldSource,
  ZoomOutBehavior,
} from '@maprama/protocol';
import { HOLO_ICON_TILES, LABEL_CONTENT_MODES, LABEL_STYLES, LOCATION_SOURCE_KINDS, PRESET_NAMES, TIMES_OF_DAY, ZOOM_OUT_BEHAVIORS } from '@maprama/protocol';
import { createDirectTransport, createEngine } from '../src/index.js';
import type { WorldModel } from '../src/world/model.js';

declare global {
  interface Window {
    __MAPRAMA_READY__?: boolean;
    __engine?: ReturnType<typeof createEngine>;
  }
}

const params = new URLSearchParams(location.hash.slice(1));
const flag = (k: string): boolean | undefined => (params.has(k) ? params.get(k) === '1' : undefined);
const num = (k: string): number | undefined => {
  const v = params.get(k);
  return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
};
const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
  const v = params.get(k);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
};

type Layout = 'grid' | 'town' | 'sample';
type TravelChoice = TravelMode | 'mixed';
const TRAVEL_CHOICES: readonly TravelChoice[] = ['walk', 'bike', 'car', 'plane', 'subway', 'mixed'];
const MUSIC_DROPS: readonly DropType[] = ['coin', 'cd', 'vinyl', 'note'];
const state = {
  layout: (pick<Layout>('layout', ['grid', 'town', 'sample']) ?? 'town') as Layout,
  preset: pick<PresetName>('preset', PRESET_NAMES) ?? 'urban',
  tod: pick<TimeOfDay>('tod', TIMES_OF_DAY) ?? 'day',
  zo: pick<ZoomOutBehavior>('zo', ZOOM_OUT_BEHAVIORS) ?? 'keepGameView',
  cine: flag('cine'),
  details: flag('details'),
  massing: pick<'box' | 'varied'>('massing', ['box', 'varied']),
  facade: flag('facade'),
  outline: flag('outline'),
  shadows: flag('shadows'),
  lanes: flag('lanes'),
  crosswalks: flag('crosswalks'),
  props: flag('props'),
  parked: flag('parked'),
  labels: (pick<LabelStyle | 'off'>('labels', [...LABEL_STYLES, 'off']) ?? 'off') as LabelStyle | 'off',
  icons: pick<HoloIconTile>('icons', HOLO_ICON_TILES) ?? 'auto',
  content: pick<LabelContentMode>('content', LABEL_CONTENT_MODES) ?? 'nameAndType',
  ui: flag('ui') ?? false,
  loc: pick<LocationSourceKind>('loc', LOCATION_SOURCE_KINDS) ?? 'simulated',
  travelMode: pick<TravelChoice>('travel', TRAVEL_CHOICES) ?? ('walk' as TravelChoice),
};

function theme(): ThemeSpec {
  const t: ThemeSpec = { base: state.preset, timeOfDay: state.tod, zoomOut: state.zo };
  if (state.cine !== undefined) t.cinematic = state.cine;
  if (state.shadows !== undefined) t.shadows = state.shadows;
  const b: NonNullable<ThemeSpec['buildings']> = {};
  if (state.details !== undefined) b.details = state.details;
  if (state.massing) b.massing = state.massing;
  if (state.facade !== undefined) b.facade = state.facade;
  if (state.outline !== undefined) b.outline = state.outline;
  if (Object.keys(b).length) t.buildings = b;
  const r: NonNullable<ThemeSpec['roads']> = {};
  if (state.lanes !== undefined) r.laneMarkings = state.lanes;
  if (state.crosswalks !== undefined) r.crosswalks = state.crosswalks;
  if (Object.keys(r).length) t.roads = r;
  const s: NonNullable<ThemeSpec['street']> = {};
  if (state.props !== undefined) s.props = state.props;
  if (state.parked !== undefined) s.parked = state.parked;
  if (Object.keys(s).length) t.street = s;
  return t;
}

const labelsSpec = (): LabelsSpec => (state.labels === 'off' ? { enabled: false } : { enabled: true, style: state.labels, icons: state.icons, content: state.content });
const uiSpec = (): MapUiSpec => {
  const ui: MapUiSpec = state.ui ? { locationPuck: true, scaleBar: true, zoomButtons: true, attribution: true } : {};
  const inset = num('inset');
  if (inset !== undefined && inset > 0) ui.contentInset = { bottom: inset };
  return ui;
};
const modesFor = (c: TravelChoice): TravelMode[] => (c === 'mixed' ? ['walk', 'car', 'walk'] : [c]);

const panel = document.getElementById('panel')!;
const logEl = document.createElement('div');
logEl.className = 'log';
const log = (msg: string): void => { logEl.textContent = msg; };

let lastIndex: LabelInfo[] = [];
let hasPlayer = false;
let npcCount = 0;
/** Travel defaults to real-world speed; the dev harness fast-forwards 20× (about the old demo pace). */
const DEMO_TIME_SCALE = 20;
const listeners = new Set<(e: EngineEvent) => void>();
const transport = createDirectTransport();
transport.onEvent((event, raw) => {
  if (!event) { console.error('undecodable engine event', raw); return; }
  if (event.type === 'error') console.error(`engine error [${event.code}] ${event.message}`);
  else if (event.type === 'labelsIndex') lastIndex = event.labels;
  else if (event.type === 'map:press') {
    log(`map:press ${event.coordinate.lng.toFixed(5)}, ${event.coordinate.lat.toFixed(5)}`);
    if (hasPlayer) send({ type: 'travel', requestId: `tap-${Date.now()}`, characterId: 'me', to: event.coordinate, modes: modesFor(state.travelMode), timeScale: DEMO_TIME_SCALE });
  } else if (event.type === 'building:press') log(`building:press ${event.buildingId}`);
  else if (event.type === 'drop:collect') log(`drop:collect ${event.dropId} by ${event.characterId}\ncollectId ${event.collectId}`);
  else if (event.type === 'travel:start') log(`travel:start ${event.legs.map((l) => `${l.mode} ${Math.round(l.meters)}m`).join(' → ')}`);
  else if (event.type === 'travel:arrive') log('travel:arrive');
  else if (event.type === 'geofence:enter' || event.type === 'geofence:exit') log(`${event.type} ${event.geofenceId}`);
  for (const l of [...listeners]) l(event);
});
const engine = createEngine(document.getElementById('map')!, { transport });
window.__engine = engine;
const send = (cmd: EngineCommand): void => transport.postCommand(cmd);

/** Resolves with the first event for which `pick` returns a value. */
function waitFor<T>(pickFn: (e: EngineEvent) => T | undefined, timeoutMs = 120000): Promise<T> {
  return new Promise((resolve, reject) => {
    const fn = (e: EngineEvent): void => {
      const v = pickFn(e);
      if (v === undefined) return;
      clearTimeout(timer);
      listeners.delete(fn);
      resolve(v);
    };
    const timer = setTimeout(() => { listeners.delete(fn); reject(new Error('timed out waiting for an engine event')); }, timeoutMs);
    listeners.add(fn);
  });
}

/** Sample host content for `content=custom` (prototype `holoCustomSub`). */
function sampleContent(labels: readonly LabelInfo[]): Record<string, LabelContent> {
  const poi: Record<string, string> = { music: '오늘의 드롭 3곡', cafe: '영업 중 · 22시까지', subway: '2분 후 도착', store: '24시간 영업', school: '방과후 이벤트', book: '신간 입고', plaza: '점령 이벤트 진행 중', park: '산책 퀘스트' };
  const out: Record<string, LabelContent> = {};
  for (const l of labels) {
    const n = [...l.name].reduce((a, c) => a + c.charCodeAt(0), 0);
    if (l.kind === 'poi') out[l.id] = { title: l.name, subtitle: poi[l.category ?? 'plaza'] ?? l.subtitle ?? '' };
    else if (l.kind === 'road') out[l.id] = { title: l.name, subtitle: `내 위치에서 ${(2 + (n % 9)) * 40}m` };
    else out[l.id] = l.subtitle?.includes('RIVER') ? { title: l.name, subtitle: '수변 산책 퀘스트', icon: 'water' } : { title: l.name, subtitle: `지금 ${3 + (n % 22)}명 플레이 중` };
  }
  return out;
}

/**
 * Sample place-card content per POI category, in the shape a map app shows: a
 * category subtitle, an opening-hours badge, detail rows and actions.
 */
const CARD_SAMPLES: Readonly<Record<string, { subtitle: string; badge: { text: string; tone: 'good' | 'warn' | 'bad' }; rows: string[]; actions: string[] }>> = {
  cafe: { subtitle: '카페 · CAFE', badge: { text: '영업 중', tone: 'good' }, rows: ['22:00 영업 종료', '성수동2가 273-13', '02-000-0000'], actions: ['길찾기', '전화'] },
  music: { subtitle: '음반 · RECORDS', badge: { text: '곧 마감', tone: 'warn' }, rows: ['21:00 영업 종료', '성수이로 78', '오늘의 드롭 3곡'], actions: ['예약', '공유'] },
  store: { subtitle: '편의점 · STORE', badge: { text: '24시간', tone: 'good' }, rows: ['연중무휴', '연무장길 41', '택배 접수 가능'], actions: ['길찾기'] },
  book: { subtitle: '서점 · BOOKS', badge: { text: '영업 종료', tone: 'bad' }, rows: ['내일 10:00 영업 시작', '아차산로 105', '신간 입고'], actions: ['길찾기', '전화'] },
  park: { subtitle: '공원 · PARK', badge: { text: '개방', tone: 'good' }, rows: ['상시 개방', '성수동1가 일대', '산책 퀘스트 진행 중'], actions: ['길찾기'] },
  plaza: { subtitle: '광장 · PLAZA', badge: { text: '이벤트', tone: 'good' }, rows: ['오늘 19:00 점령전', '성수광장', '참가자 24명'], actions: ['참가'] },
  subway: { subtitle: '지하철역 · STATION', badge: { text: '운행 중', tone: 'good' }, rows: ['다음 열차 2분', '2호선 · 수인분당선', '엘리베이터 있음'], actions: ['길찾기', '시간표'] },
  school: { subtitle: '학교 · SCHOOL', badge: { text: '방과후', tone: 'good' }, rows: ['17:00 하교', '성수동1가 656', '방과후 이벤트'], actions: ['길찾기'] },
};
const DEFAULT_CARD = CARD_SAMPLES.cafe!;
const ROW_ICONS = ['hours', 'location', 'info'] as const;

/** Anchors of the info cards: the nearest POIs, or the nearest building centroids (for `roof`). */
function cardAnchors(count: number, on: 'poi' | 'building', cx: number, cz: number): { id: string; name: string; cat: string; x: number; z: number }[] {
  const w = engine.scene!.world()!;
  if (on === 'building') {
    return [...w.buildings]
      .sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))
      .slice(0, count)
      .map((b, i) => ({ id: b.id, name: b.name || `빌딩 ${i + 1}`, cat: 'store', x: b.x, z: b.z }));
  }
  return [...w.pois]
    .sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))
    .slice(0, count)
    .map((p) => ({ id: p.id, name: p.name, cat: p.cat, x: p.x, z: p.z }));
}

/**
 * Drops `count` app-owned markers on the POIs nearest the view centre. The
 * side-by-side of `markerAnchor=ground` and `markerAnchor=roof` is what the
 * pin-accuracy screenshots compare.
 */
async function showMarkers(count: number, anchorHeight: MarkerAnchorHeight, snap: boolean, cx: number, cz: number): Promise<void> {
  const scene = engine.scene!;
  const markers: MarkerSpec[] = cardAnchors(count, 'poi', cx, cz).map((a, i) => {
    const m: MarkerSpec = {
      id: `mk-${a.id}`,
      coordinate: scene.toLngLat({ x: a.x, z: a.z }),
      color: i === 0 ? '#E2445C' : '#2F5BEA',
      accessibilityLabel: a.name,
      anchorHeight,
    };
    if (snap) m.snapToBuilding = true;
    return m;
  });
  await engine.dispatch({ type: 'setMarkerLayer', layerId: 'poi', markers });
}

/** Shows `count` info cards around the view centre; returns the card ids in placement order. */
async function showInfoCards(count: number, anchor: InfoCardAnchor, on: 'poi' | 'building', cx: number, cz: number): Promise<string[]> {
  const scene = engine.scene!;
  const anchors = cardAnchors(count, on, cx, cz);
  const ids: string[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!, sample = CARD_SAMPLES[a.cat] ?? DEFAULT_CARD;
    const card: InfoCardSpec = {
      id: `card-${a.id}`,
      coordinate: scene.toLngLat({ x: a.x, z: a.z }),
      anchor,
      dismissible: true,
      content: {
        title: a.name,
        subtitle: sample.subtitle,
        icon: (a.cat as InfoCardSpec['content']['icon']) ?? 'store',
        badges: [{ text: sample.badge.text, tone: sample.badge.tone }],
        rating: { value: Math.round(38 + ((i * 3) % 12)) / 10, count: 128 + i * 337 },
        rows: sample.rows.map((text, k) => ({ icon: ROW_ICONS[k % ROW_ICONS.length]!, text })),
        actions: sample.actions.map((label, k) => (k === 0 ? { id: `a${k}`, label, primary: true } : { id: `a${k}`, label })),
      },
    };
    ids.push(card.id);
    await engine.dispatch({ type: 'setInfoCard', card });
  }
  return ids;
}

/**
 * `focusOn` an info card and wait for the response — the reference for what an
 * app does after a press. The engine never does this by itself.
 */
async function focusOnCard(id: string): Promise<void> {
  const requestId = `focus-${id}`;
  const answer = waitFor((e) => (e.type === 'response' && e.requestId === requestId ? e : undefined), 10000);
  await engine.dispatch({ type: 'request', requestId, method: 'focusOn', params: { infoCardId: id, pitch: 52, animate: { durationMs: 400 } } });
  const res = await answer;
  if (!res.ok) console.error(`focusOn failed [${res.error.code}] ${res.error.message}`);
  else log(`focusOn ${id}: fitted=${(res.result as { fitted: boolean }).fitted}`);
}

function snapWorld(x: number, z: number): { x: number; z: number } {
  const s = engine.scene?.snapToRoad(x, z);
  return s ? { x: s.x, z: s.z } : { x, z };
}

async function playerPosition(): Promise<{ x: number; z: number }> {
  const scene = engine.scene!;
  const p = waitFor((e) => (e.type === 'character:position' && e.id === 'me' ? e.coordinate : undefined), 10000);
  await engine.dispatch({ type: 'subscribe', topic: 'character:position', id: 'me', throttleMs: 0 });
  const c = await p;
  await engine.dispatch({ type: 'unsubscribe', topic: 'character:position', id: 'me' });
  return scene.toWorld(c);
}

async function addPlayer(nearStation: boolean): Promise<void> {
  const scene = engine.scene!;
  const w = scene.world()!;
  const model = params.get('model');
  const spec: EngineCommand = { type: 'upsertCharacters', characters: [{ id: 'me', name: '나', isPlayer: true, showNameTag: true, color: '#3F63D6', ...(model ? { model: { uri: model } } : {}) }] };
  if (nearStation && w.stations.length >= 2) {
    const st = [...w.stations].sort((a, b) => a.x - b.x)[0]!;
    spec.characters[0]!.position = scene.toLngLat(snapWorld(st.x + 4, st.z + 4));
  }
  await engine.dispatch(spec);
  hasPlayer = true;
}

/** Resolves once the character shows its glTF model (logs an error after `timeoutMs`). */
function waitForModel(id: string, timeoutMs = 30000): Promise<void> {
  const scene = engine.scene!;
  const started = performance.now();
  return new Promise<void>((resolve) => {
    const off = scene.onFrame(() => {
      const root = scene.groups.dynamic.getObjectByName(`character:${id}`);
      if (root?.children.some((c) => c.userData.model)) { off(); resolve(); }
      else if (performance.now() - started > timeoutMs) { off(); console.error(`model for "${id}" was not attached within ${timeoutMs} ms`); resolve(); }
    });
  });
}

async function dropAround(type: DropType, cx: number, cz: number): Promise<void> {
  const scene = engine.scene!;
  const w = scene.world()!;
  const rarities: Rarity[] = ['common', 'rare', 'legendary'];
  const drops: DropSpec[] = [];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + 0.4, r = 4 + (k % 3) * 2.5;
    let p = snapWorld(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    if (Math.hypot(p.x - cx, p.z - cz) < 2.6) p = { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
    const d: DropSpec = { id: `${type}-${k}`, type, coordinate: scene.toLngLat(p), rarity: rarities[k % 3]!, value: type === 'coin' ? (k % 3 === 2 ? 50 : 10) : 1 };
    drops.push(d);
  }
  await engine.dispatch({ type: 'setDropLayer', layerId: 'demo', drops, collectRadiusMeters: 1.7 * w.unitMeters });
}

/** Starts a demo trip; resolves in the middle of its characteristic leg. */
async function demoTravel(choice: TravelChoice): Promise<void> {
  const scene = engine.scene!;
  const w = scene.world()!;
  const p = await playerPosition();
  const b = w.bounds, m = 6;
  const clampX = (x: number): number => Math.max(b.minX + m, Math.min(b.maxX - m, x));
  const clampZ = (z: number): number => Math.max(b.minZ + m, Math.min(b.maxZ - m, z));
  let dest: { x: number; z: number };
  if (choice === 'plane') dest = { x: clampX(p.x + 45), z: clampZ(p.z - 30) };
  else if (choice === 'subway') {
    const st = [...w.stations].sort((a, c) => Math.hypot(c.x - p.x, c.z - p.z) - Math.hypot(a.x - p.x, a.z - p.z))[0];
    dest = st ? snapWorld(st.x + 3, st.z + 3) : { x: p.x + 20, z: p.z };
  } else {
    let best = { x: p.x + 10, z: p.z }, bd = -1;
    w.graph.nodes.forEach((n, i) => {
      if (!w.graph.adj[i]!.length) return;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d <= 70 && d > bd) { bd = d; best = { x: n.x, z: n.z }; }
    });
    dest = best;
  }
  const started = waitFor((e) => (e.type === 'travel:start' && e.requestId === 'demo' ? e : undefined));
  await engine.dispatch({ type: 'subscribe', topic: 'travel:progress', id: 'me', throttleMs: 0 });
  await engine.dispatch({ type: 'setCamera', camera: { follow: 'me' } });
  await engine.dispatch({ type: 'travel', requestId: 'demo', characterId: 'me', to: scene.toLngLat(dest), modes: modesFor(choice), timeScale: DEMO_TIME_SCALE });
  const start = await started;
  const target: TravelMode = choice === 'plane' || choice === 'subway' ? choice : choice === 'mixed' ? 'car' : choice;
  const idx = start.legs.findIndex((l) => l.mode === target);
  if (idx < 0) { console.error(`demo travel: no ${target} leg in ${start.legs.map((l) => l.mode).join(',')}`); return; }
  const total = start.legs.reduce((a, l) => a + l.meters, 0);
  const before = start.legs.slice(0, idx).reduce((a, l) => a + l.meters, 0);
  const threshold = total - (before + start.legs[idx]!.meters * 0.4);
  await waitFor((e) => {
    if (e.type === 'travel:arrive' && e.requestId === 'demo') { console.error('demo travel arrived before reaching its mid-leg'); return true; }
    return e.type === 'travel:progress' && e.requestId === 'demo' && e.mode === target && e.remainingMeters <= threshold ? true : undefined;
  });
}

async function init(world?: WorldSource): Promise<void> {
  window.__MAPRAMA_READY__ = false;
  hasPlayer = false;
  const source: WorldSource = world ?? (state.layout === 'sample' ? { kind: 'url', url: params.get('world') || './sample-world.json' } : { kind: 'procedural', layout: state.layout });
  await engine.dispatch({ type: 'init', world: source, theme: theme(), labels: labelsSpec(), ui: uiSpec(), locationSource: state.loc });
  const scene = engine.scene;
  if (!scene) return;
  const w = scene.world();
  if (!w) return;
  // Rendering is on demand, so the set-up below (which waits for frames, for a model to attach and
  // for the scene to settle) has to keep the loop running; released once the page is ready.
  const releaseRender = scene.addActiveSource('playground:init');
  try {
    await setUpScene(scene, w);
  } finally {
    releaseRender();
  }
  window.__MAPRAMA_READY__ = true;
}

async function setUpScene(scene: NonNullable<typeof engine.scene>, w: WorldModel): Promise<void> {
  const x = num('x') ?? w.start.x, z = num('z') ?? w.start.z;
  await engine.dispatch({
    type: 'setCamera',
    camera: {
      center: scene.toLngLat({ x, z }),
      distance: (num('dist') ?? 48) * w.unitMeters,
      pitch: num('pitch') ?? 40,
      bearing: num('bearing') ?? 28,
    },
  });
  if (state.content === 'custom') await engine.dispatch({ type: 'setLabelContent', entries: sampleContent(lastIndex) });
  const travel = pick<TravelChoice>('travel', TRAVEL_CHOICES);
  if (flag('player') || travel) await addPlayer(travel === 'subway');
  if (params.get('model') && (flag('player') || travel)) await waitForModel('me');
  const drops = pick<DropType>('drops', MUSIC_DROPS);
  if (drops) await dropAround(drops, x, z);
  const markers = num('markers');
  if (markers && markers > 0) {
    await showMarkers(
      markers,
      pick<'ground' | 'roof'>('markerAnchor', ['ground', 'roof']) ?? 'ground',
      flag('markerSnap') === true,
      x,
      z,
    );
  }
  const cards = num('cards');
  if (cards && cards > 0) {
    const ids = await showInfoCards(
      cards,
      pick<InfoCardAnchor>('cardAnchor', ['ground', 'roof', 'auto']) ?? 'auto',
      pick<'poi' | 'building'>('cardsOn', ['poi', 'building']) ?? 'poi',
      x,
      z,
    );
    if (flag('focus') && ids[0]) await focusOnCard(ids[0]);
  }
  const need = scene.frames() + (num('frames') ?? 24);
  await new Promise<void>((resolve) => {
    const off = scene.onFrame(() => { if (scene.frames() >= need) { off(); resolve(); } });
  });
  if (travel) await demoTravel(travel);
  const settle = num('settle') ?? 0;
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
}

function updateHash(): void {
  const h = new URLSearchParams(location.hash.slice(1));
  h.set('layout', state.layout);
  h.set('preset', state.preset);
  h.set('tod', state.tod);
  h.set('zo', state.zo);
  for (const k of ['cine', 'details', 'lanes', 'crosswalks', 'props', 'parked'] as const) {
    const v = state[k];
    if (v === undefined) h.delete(k); else h.set(k, v ? '1' : '0');
  }
  if (state.massing) h.set('massing', state.massing);
  h.set('labels', state.labels);
  h.set('icons', state.icons);
  h.set('content', state.content);
  if (state.ui) h.set('ui', '1'); else h.delete('ui');
  history.replaceState(null, '', '#' + h.toString());
}

function buildPanel(): void {
  if (params.get('panel') === '0') { panel.hidden = true; return; }
  panel.innerHTML = '<h1>engine-web playground</h1>';
  const heading = (text: string): void => {
    const h = document.createElement('h2');
    h.textContent = text;
    panel.append(h);
  };
  const select = <T extends string>(label: string, values: readonly T[], get: () => T, set: (v: T) => void): void => {
    const l = document.createElement('label');
    l.textContent = label;
    const s = document.createElement('select');
    for (const v of values) s.add(new Option(v, v, false, v === get()));
    s.addEventListener('change', () => set(s.value as T));
    l.append(s);
    panel.append(l);
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void): void => {
    const l = document.createElement('label');
    l.textContent = label;
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = get();
    c.addEventListener('change', () => set(c.checked));
    l.append(c);
    panel.append(l);
  };
  const button = (text: string, onClick: () => void, parent: HTMLElement = panel): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    parent.append(b);
    return b;
  };
  const row = (): HTMLDivElement => {
    const r = document.createElement('div');
    r.className = 'row';
    panel.append(r);
    return r;
  };
  const resolved = (): NonNullable<ReturnType<NonNullable<typeof engine.scene>['params']>> | null => engine.scene?.params() ?? null;
  const retheme = (): void => { updateHash(); send({ type: 'setTheme', theme: theme() }); };
  const relabel = (): void => {
    updateHash();
    send({ type: 'setLabels', labels: labelsSpec() });
    if (state.content === 'custom') send({ type: 'setLabelContent', entries: sampleContent(lastIndex) });
  };
  select('layout', ['grid', 'town', 'sample'] as const, () => state.layout, (v) => { state.layout = v; updateHash(); void init(); });
  select('preset', PRESET_NAMES, () => state.preset, (v) => {
    state.preset = v;
    for (const k of ['cine', 'details', 'massing', 'lanes', 'crosswalks', 'props', 'parked'] as const) (state as Record<string, unknown>)[k] = undefined;
    retheme();
    buildPanel();
  });
  select('time', TIMES_OF_DAY, () => state.tod, (v) => { state.tod = v; retheme(); });
  select('zoom out', ZOOM_OUT_BEHAVIORS, () => state.zo, (v) => { state.zo = v; retheme(); });
  const p = resolved();
  check('cinematic', () => state.cine ?? p?.resolved.cinematic ?? false, (v) => { state.cine = v; retheme(); });
  check('varied massing', () => (state.massing ?? p?.massing) === 'varied', (v) => { state.massing = v ? 'varied' : 'box'; retheme(); });
  check('facade details', () => state.details ?? p?.details ?? false, (v) => { state.details = v; retheme(); });
  check('lane markings', () => state.lanes ?? p?.roads.laneMarkings ?? true, (v) => { state.lanes = v; retheme(); });
  check('crosswalks', () => state.crosswalks ?? p?.roads.crosswalks ?? true, (v) => { state.crosswalks = v; retheme(); });
  check('street props', () => state.props ?? p?.street.props ?? true, (v) => { state.props = v; retheme(); });
  check('parked cars', () => state.parked ?? p?.street.parked ?? false, (v) => { state.parked = v; retheme(); });

  heading('Labels & map UI');
  select('label style', ['off', ...LABEL_STYLES] as const, () => state.labels, (v) => { state.labels = v; relabel(); });
  select('icon tiles', HOLO_ICON_TILES, () => state.icons, (v) => { state.icons = v; relabel(); });
  select('content', LABEL_CONTENT_MODES, () => state.content, (v) => { state.content = v; relabel(); });
  check('map UI', () => state.ui, (v) => { state.ui = v; updateHash(); send({ type: 'setUi', ui: uiSpec() }); });
  select('location', LOCATION_SOURCE_KINDS, () => state.loc, (v) => { state.loc = v; send({ type: 'setLocationSource', source: v }); });

  heading('Characters');
  const url = document.createElement('input');
  url.type = 'text';
  url.placeholder = 'glTF / GLB URL (optional)';
  url.setAttribute('aria-label', 'glTF or GLB model URL');
  panel.append(url);
  const charRow = row();
  button('Add player', () => {
    if (hasPlayer) return;
    const model = url.value.trim();
    void engine.dispatch({ type: 'upsertCharacters', characters: [{ id: 'me', name: '나', isPlayer: true, showNameTag: true, ...(model ? { model: { uri: model } } : {}) }] }).then(() => {
      hasPlayer = true;
      send({ type: 'setCamera', camera: { follow: 'me' } });
    });
  }, charRow);
  button('Add character', () => {
    const scene = engine.scene;
    if (!scene?.world()) return;
    const o = scene.camera.orbit, a = npcCount * 1.3;
    const pos = snapWorld(o.x + Math.cos(a) * 6, o.z + Math.sin(a) * 6);
    const model = url.value.trim();
    npcCount++;
    send({ type: 'upsertCharacters', characters: [{ id: `npc-${npcCount}`, name: `NPC ${npcCount}`, showNameTag: true, position: scene.toLngLat(pos), ...(model ? { model: { uri: model } } : {}) }] });
  }, charRow);
  button('Follow location', () => {
    if (hasPlayer) send({ type: 'upsertCharacters', characters: [{ id: 'me', follow: 'location' }] });
  }, charRow);

  heading('Travel (tap the map)');
  const travelRow = row();
  const travelButtons = TRAVEL_CHOICES.map((c) => {
    const b = button(c, () => {
      state.travelMode = c;
      travelButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }, travelRow);
    b.setAttribute('aria-pressed', String(c === state.travelMode));
    return b;
  });
  const goRow = row();
  button('Go far', () => { if (hasPlayer) void demoTravel(state.travelMode).catch(() => {}); }, goRow);
  button('Cancel', () => { if (hasPlayer) send({ type: 'cancelTravel', characterId: 'me' }); }, goRow);

  heading('Drops');
  const dropRow = row();
  for (const t of MUSIC_DROPS) {
    button(t, () => {
      const o = engine.scene?.camera.orbit;
      if (o) void dropAround(t, o.x, o.z);
    }, dropRow);
  }

  heading('World');
  button('Load sample WorldData', async () => {
    const res = await fetch('./sample-world.json');
    const data = (await res.json()) as WorldData;
    state.layout = 'sample';
    updateHash();
    await init({ kind: 'data', world: data });
    log(`loaded "${data.name}" (${data.buildings.length} buildings)`);
  });
  button('Reset north', () => engine.scene?.camera.toNorth());
  panel.append(logEl);
}

void init().then(buildPanel);
