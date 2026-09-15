<script setup lang="ts">
/**
 * Interactive playground: runs the real `@maprama/engine-web` in the page via
 * `createEngine` + the in-page direct transport, drives it with protocol
 * commands, and mirrors the state as `@maprama/react-native` JSX and theme JSON.
 *
 * The engine implements labels, characters/travel and drops. If an engine build
 * answers a command with `unsupported` (or the legacy `NOT_IMPLEMENTED`), the
 * matching control group shows a short note instead of a console error, and
 * the rest of the map keeps running.
 *
 * `window.__mapramaPlayground` exposes the engine, the reactive state and a
 * small event probe for `scripts/screenshot.mjs`.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { withBase } from 'vitepress';
import type { DirectTransport, EngineHandle } from '@maprama/engine-web';
import type { DropSpec, EngineCommand, EngineEvent, LabelInfo, LngLat, TravelMode } from '@maprama/protocol';
import {
  OPTIONS,
  WORLDS,
  customLabelContent,
  defaultState,
  groupOfUnsupported,
  highlight,
  isUnsupported,
  labelsSpec,
  reactNativeJsx,
  themeJson,
  themeSpec,
  worldSource,
  type FeatureGroup,
  type PlaygroundState,
} from './model';

/** Event counts and the player's latest position, read by the headless check. */
interface PlaygroundProbe {
  events: Record<string, number>;
  start: LngLat | null;
  position: LngLat | null;
}

declare global {
  interface Window {
    __MAPRAMA_PLAYGROUND_READY__?: boolean;
    __mapramaPlayground?: {
      engine: EngineHandle;
      transport: DirectTransport;
      state: PlaygroundState;
      probe: PlaygroundProbe;
      travelTo: (to?: LngLat) => void;
    };
  }
}

const props = withDefaults(defineProps<{ variant?: 'full' | 'hero' }>(), { variant: 'full' });
const isHero = computed(() => props.variant === 'hero');

const state = reactive(defaultState());
if (props.variant === 'hero') state.distance = 58;

const mapEl = ref<HTMLElement | null>(null);
const status = ref<'loading' | 'ready' | 'error' | 'nowebgl'>('loading');
const statusText = ref('엔진을 불러오는 중…');
const unsupported = reactive<Record<FeatureGroup, boolean>>({ labels: false, travel: false, drops: false });
const traveling = ref(false);
const log = ref<{ id: number; kind: 'info' | 'warn'; text: string }[]>([]);
const codeTab = ref<'jsx' | 'theme'>('jsx');
const inlinePreset = ref(false);
const copied = ref<'' | 'jsx' | 'theme' | 'fail'>('');

let engine: EngineHandle | null = null;
let transport: DirectTransport | null = null;
let unmounted = false;
let loadToken = 0;
let disposeFrame: (() => void) | null = null;
let logSeq = 0;
let travelSeq = 0;
let labelsIndex: LabelInfo[] = [];
let start: LngLat | null = null;
let dropCoords: LngLat[] = [];
const probe: PlaygroundProbe = { events: {}, start: null, position: null };

const worldNote = computed(() => WORLDS.find((w) => w.id === state.world)?.note ?? '');
const jsx = computed(() => reactNativeJsx(state));
const jsxHtml = computed(() => highlight(jsx.value));
const theme = computed(() => themeJson(state, inlinePreset.value));
const themeHtml = computed(() => highlight(theme.value));

function pushLog(kind: 'info' | 'warn', text: string): void {
  log.value = [{ id: logSeq++, kind, text }, ...log.value].slice(0, 5);
}

function send(command: EngineCommand): void {
  transport?.postCommand(command);
}

// ---------------------------------------------------------------------------
// engine events
// ---------------------------------------------------------------------------

function onEvent(event: EngineEvent | null): void {
  if (!event) {
    pushLog('warn', '프로토콜 검증에 실패한 엔진 메시지를 무시했어요');
    return;
  }
  probe.events[event.type] = (probe.events[event.type] ?? 0) + 1;
  switch (event.type) {
    case 'character:position':
      if (event.id === 'me') probe.position = event.coordinate;
      return;
    case 'error': {
      if (isUnsupported(event.code)) {
        const group = groupOfUnsupported(event.message);
        if (group) unsupported[group] = true;
        else pushLog('info', `미지원: ${event.message}`);
        return;
      }
      if (event.code === 'webgl_unavailable') {
        status.value = 'nowebgl';
        statusText.value = '이 브라우저에서는 WebGL을 사용할 수 없어요';
        return;
      }
      if (event.code === 'world_load_failed') {
        status.value = 'error';
        statusText.value = '월드를 불러오지 못했어요';
      }
      pushLog('warn', `[${event.code}] ${event.message}`);
      return;
    }
    case 'response':
      if (!event.ok && !isUnsupported(event.error.code)) pushLog('warn', `[${event.error.code}] ${event.error.message}`);
      return;
    case 'labelsIndex':
      unsupported.labels = false;
      labelsIndex = event.labels;
      if (state.labelContent === 'custom') sendLabelContent();
      return;
    case 'travel:start':
      unsupported.travel = false;
      traveling.value = true;
      pushLog('info', `travel:start → ${state.travelModes.join(' · ')}`);
      return;
    case 'travel:arrive':
      traveling.value = false;
      pushLog('info', 'travel:arrive 도착');
      return;
    case 'travel:cancel':
      traveling.value = false;
      pushLog('info', 'travel:cancel');
      return;
    case 'drop:collect':
      unsupported.drops = false;
      pushLog('info', `drop:collect ${event.dropId} (collectId ${event.collectId.slice(0, 8)}…)`);
      return;
    case 'building:press':
      pushLog('info', `building:press ${event.buildingId}`);
      return;
    case 'map:press':
      pushLog('info', `map:press ${event.coordinate.lng.toFixed(5)}, ${event.coordinate.lat.toFixed(5)}`);
      if (!isHero.value) startTravel(event.coordinate);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function worldUrl(path: string): string {
  return new URL(withBase(`/${path}`), window.location.href).href;
}

function loadWorld(): void {
  const scene = engine?.scene;
  if (!engine || !transport) return;
  if (!scene) {
    status.value = 'nowebgl';
    statusText.value = '이 브라우저에서는 WebGL을 사용할 수 없어요';
    return;
  }
  const token = ++loadToken;
  disposeFrame?.();
  disposeFrame = null;
  window.__MAPRAMA_PLAYGROUND_READY__ = false;
  status.value = 'loading';
  statusText.value = '월드를 불러오는 중…';
  traveling.value = false;
  labelsIndex = [];
  probe.events = {};
  probe.start = null;
  probe.position = null;
  const previous = scene.world();
  send({
    type: 'init',
    world: worldSource(state, worldUrl),
    theme: themeSpec(state),
    labels: labelsSpec(state),
    ui: { attribution: state.world === 'seongsu' },
    locationSource: 'external',
  });
  let readyAt = -1;
  disposeFrame = scene.onFrame(() => {
    if (token !== loadToken) return;
    if (readyAt < 0) {
      const w = scene.world();
      if (!w || w === previous) return;
      readyAt = scene.frames() + 24;
      afterWorldLoad();
      return;
    }
    if (scene.frames() >= readyAt) {
      disposeFrame?.();
      disposeFrame = null;
      status.value = 'ready';
      window.__MAPRAMA_PLAYGROUND_READY__ = true;
    }
  });
}

function afterWorldLoad(): void {
  const scene = engine?.scene;
  const w = scene?.world();
  if (!scene || !w) return;
  start = scene.toLngLat({ x: w.start.x, z: w.start.z });
  dropCoords = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const r = i % 2 ? 9 : 5;
    return scene.toLngLat({ x: w.start.x + Math.cos(a) * r, z: w.start.z + Math.sin(a) * r });
  });
  probe.start = start;
  probe.position = start;
  applyCamera();
  // game features: labels, the player character (moved only by `travel`), drops
  send({ type: 'setLabels', labels: labelsSpec(state) });
  send({
    type: 'upsertCharacters',
    characters: [{ id: 'me', isPlayer: true, name: '나', color: '#2F5BEA', position: start, follow: 'none', showNameTag: true }],
  });
  send({ type: 'subscribe', topic: 'character:position', id: 'me', throttleMs: 200 });
  sendDrops();
}

function applyCamera(): void {
  const w = engine?.scene?.world();
  if (!w || !start) return;
  send({
    type: 'setCamera',
    camera: { center: start, distance: state.distance * w.unitMeters, pitch: isHero.value ? 44 : 40, bearing: 28 },
  });
}

function sendDrops(): void {
  if (!dropCoords.length) return;
  const drops: DropSpec[] = dropCoords.map((coordinate, i) => ({
    id: `drop-${i}`,
    type: state.dropType,
    rarity: state.dropRarity,
    coordinate,
    value: 10,
    payload: { index: i },
  }));
  send({ type: 'setDropLayer', layerId: 'demo', drops, collectRadiusMeters: 15, collectorIds: ['me'] });
}

function sendLabelContent(): void {
  if (!labelsIndex.length) return;
  const entries = Object.fromEntries(labelsIndex.map((label) => [label.id, customLabelContent(label)]));
  send({ type: 'setLabelContent', entries });
}

function startTravel(to?: LngLat): void {
  const target = to ?? dropCoords[3] ?? start;
  if (!target || !state.travelModes.length) return;
  send({ type: 'travel', requestId: `pg-${++travelSeq}`, characterId: 'me', to: target, modes: [...state.travelModes] });
}

function cancelTravel(): void {
  send({ type: 'cancelTravel', characterId: 'me' });
}

function setMode(i: number, mode: TravelMode): void {
  state.travelModes.splice(i, 1, mode);
}
function addMode(): void {
  if (state.travelModes.length < 4) state.travelModes.push('walk');
}
function removeMode(i: number): void {
  if (state.travelModes.length > 1) state.travelModes.splice(i, 1);
}

// ---------------------------------------------------------------------------
// copy (clipboard with a selection fallback; no downloads)
// ---------------------------------------------------------------------------

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

async function copy(kind: 'jsx' | 'theme'): Promise<void> {
  const text = kind === 'jsx' ? jsx.value : theme.value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = fallbackCopy(text);
  }
  copied.value = ok ? kind : 'fail';
  window.setTimeout(() => (copied.value = ''), 1800);
}

// ---------------------------------------------------------------------------
// lifecycle and watchers
// ---------------------------------------------------------------------------

onMounted(async () => {
  try {
    const mod = await import('@maprama/engine-web');
    if (unmounted || !mapEl.value) return;
    transport = mod.createDirectTransport();
    transport.onEvent((event) => onEvent(event));
    engine = mod.createEngine(mapEl.value, { transport });
    window.__mapramaPlayground = { engine, transport, state, probe, travelTo: startTravel };
    loadWorld();
  } catch (e) {
    status.value = 'error';
    statusText.value = '엔진을 불러오지 못했어요';
    pushLog('warn', e instanceof Error ? e.message : String(e));
  }
});

onBeforeUnmount(() => {
  unmounted = true;
  loadToken++;
  disposeFrame?.();
  engine?.destroy();
  engine = null;
  transport = null;
  window.__MAPRAMA_PLAYGROUND_READY__ = false;
});

watch(() => state.world, () => loadWorld());
watch(
  () => [state.preset, state.timeOfDay, state.zoomOut, state.cinematic, state.massing, state.details],
  () => send({ type: 'setTheme', theme: themeSpec(state) }),
);
watch(() => state.distance, () => applyCamera());
watch(
  () => [state.labelsEnabled, state.labelStyle, state.labelIcons, state.labelContent],
  () => {
    send({ type: 'setLabels', labels: labelsSpec(state) });
    if (state.labelContent === 'custom') sendLabelContent();
  },
);
watch(() => [state.dropType, state.dropRarity], () => sendDrops());
</script>

<template>
  <div class="mpr-pg" :class="`is-${variant}`">
    <div class="stage">
      <div ref="mapEl" class="map" />
      <div v-if="status !== 'ready'" class="veil" role="status">
        <span class="dot" :class="status" />{{ statusText }}
      </div>
      <p v-if="worldNote" class="attrib">{{ worldNote }}</p>
      <ol v-if="!isHero && log.length" class="log" aria-live="polite">
        <li v-for="item in log" :key="item.id" :class="item.kind">{{ item.text }}</li>
      </ol>
      <div v-if="isHero" class="hero-bar">
        <div class="chips" role="group" aria-label="프리셋">
          <button
            v-for="p in ['urban', 'soft', 'toy', 'realistic']"
            :key="p"
            type="button"
            :aria-pressed="state.preset === p"
            @click="state.preset = p as typeof state.preset"
          >{{ p }}</button>
        </div>
        <div class="chips" role="group" aria-label="시간대">
          <button
            v-for="t in OPTIONS.times"
            :key="t"
            type="button"
            :aria-pressed="state.timeOfDay === t"
            @click="state.timeOfDay = t"
          >{{ t }}</button>
        </div>
        <a class="open" :href="withBase('/playground/')">플레이그라운드 열기 →</a>
      </div>
    </div>

    <div v-if="!isHero" class="panel">
      <fieldset>
        <legend>월드</legend>
        <label class="row">
          <span>데이터</span>
          <select v-model="state.world">
            <option v-for="w in WORLDS" :key="w.id" :value="w.id">{{ w.label }}</option>
          </select>
        </label>
        <label class="row">
          <span>카메라 거리</span>
          <input v-model.number="state.distance" type="range" min="24" max="140" step="2" />
          <output>{{ state.distance }}</output>
        </label>
      </fieldset>

      <fieldset>
        <legend>테마</legend>
        <div class="chips" role="group" aria-label="프리셋">
          <button v-for="p in OPTIONS.presets" :key="p" type="button" :aria-pressed="state.preset === p" @click="state.preset = p">{{ p }}</button>
        </div>
        <div class="chips" role="group" aria-label="시간대">
          <button v-for="t in OPTIONS.times" :key="t" type="button" :aria-pressed="state.timeOfDay === t" @click="state.timeOfDay = t">{{ t }}</button>
        </div>
        <label class="row">
          <span>줌아웃</span>
          <select v-model="state.zoomOut">
            <option v-for="z in OPTIONS.zoomOut" :key="z" :value="z">{{ z }}</option>
          </select>
        </label>
        <div class="toggles">
          <label><input v-model="state.cinematic" type="checkbox" /> cinematic</label>
          <label><input v-model="state.massing" type="checkbox" true-value="varied" false-value="box" /> varied massing</label>
          <label><input v-model="state.details" type="checkbox" /> facade details</label>
        </div>
      </fieldset>

      <fieldset>
        <legend>라벨</legend>
        <label class="row">
          <span>스타일</span>
          <select v-model="state.labelStyle">
            <option v-for="s in OPTIONS.labelStyles" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="row">
          <span>아이콘 타일</span>
          <select v-model="state.labelIcons" :disabled="state.labelStyle !== 'holo'">
            <option v-for="s in OPTIONS.labelIcons" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="row">
          <span>내용</span>
          <select v-model="state.labelContent">
            <option v-for="s in OPTIONS.labelContent" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <div class="toggles"><label><input v-model="state.labelsEnabled" type="checkbox" /> 라벨 표시</label></div>
        <p v-if="unsupported.labels" class="unsupported" data-unsupported="labels">이 엔진은 라벨 명령에 <code>unsupported</code>로 응답했어요. 지도는 계속 동작해요.</p>
      </fieldset>

      <fieldset>
        <legend>이동</legend>
        <div class="chain" role="group" aria-label="이동 수단 순서">
          <span v-for="(m, i) in state.travelModes" :key="i" class="slot">
            <select :value="m" :aria-label="`${i + 1}번째 수단`" @change="setMode(i, ($event.target as HTMLSelectElement).value as TravelMode)">
              <option v-for="t in OPTIONS.travelModes" :key="t" :value="t">{{ t }}</option>
            </select>
            <button v-if="state.travelModes.length > 1" type="button" class="x" :aria-label="`${i + 1}번째 수단 빼기`" @click="removeMode(i)">×</button>
          </span>
          <button v-if="state.travelModes.length < 4" type="button" class="add" @click="addMode">+ 수단</button>
        </div>
        <div class="actions">
          <button type="button" class="primary" data-action="travel" @click="startTravel()">드롭 쪽으로 이동</button>
          <button type="button" :disabled="!traveling" @click="cancelTravel">취소</button>
        </div>
        <p class="hint">지도를 탭하면 그 지점으로 이동해요 (<code>onPress</code> → <code>travel</code>).</p>
        <p v-if="unsupported.travel" class="unsupported" data-unsupported="travel">이 엔진은 캐릭터·이동 명령에 <code>unsupported</code>로 응답했어요. 지도는 계속 동작해요.</p>
      </fieldset>

      <fieldset>
        <legend>드롭</legend>
        <div class="chips" role="group" aria-label="드롭 종류">
          <button v-for="t in OPTIONS.dropTypes" :key="t" type="button" :aria-pressed="state.dropType === t" @click="state.dropType = t">{{ t }}</button>
        </div>
        <div class="chips" role="group" aria-label="희귀도">
          <button v-for="r in OPTIONS.rarities" :key="r" type="button" :aria-pressed="state.dropRarity === r" @click="state.dropRarity = r">{{ r }}</button>
        </div>
        <div class="chips" role="group" aria-label="DropLayer 소스 (코드 패널)">
          <button v-for="s in OPTIONS.dropSources" :key="s" type="button" :aria-pressed="state.dropSource === s" @click="state.dropSource = s">{{ s === 'data' ? 'source: data' : 'source: service' }}</button>
        </div>
        <p v-if="state.dropSource === 'service'" class="hint">코드 패널이 호스팅 서비스용 <code>source="service"</code> JSX로 바뀌어요 (<code>userId</code> 필수). 이 페이지는 서비스 없이 같은 모양의 데모 드롭을 그려요.</p>
        <p v-if="unsupported.drops" class="unsupported" data-unsupported="drops">이 엔진은 드롭 레이어 명령에 <code>unsupported</code>로 응답했어요. 지도는 계속 동작해요.</p>
      </fieldset>
    </div>

    <div v-if="!isHero" class="code">
      <div class="code-head">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="codeTab === 'jsx'" @click="codeTab = 'jsx'">React Native JSX</button>
          <button type="button" role="tab" :aria-selected="codeTab === 'theme'" @click="codeTab = 'theme'">테마 JSON</button>
        </div>
        <label v-if="codeTab === 'theme'" class="inline"><input v-model="inlinePreset" type="checkbox" /> 프리셋 객체 포함</label>
        <button type="button" class="copy" @click="copy(codeTab)">
          {{ copied === codeTab ? '복사됨' : copied === 'fail' ? '복사 실패: 직접 선택하세요' : '복사' }}
        </button>
      </div>
      <!-- highlight() escapes all source text before adding span tags -->
      <pre v-if="codeTab === 'jsx'"><code v-html="jsxHtml" /></pre>
      <pre v-else><code v-html="themeHtml" /></pre>
    </div>
  </div>
</template>

<style scoped>
.mpr-pg {
  --pg-radius: 16px;
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(0, 1fr) 340px;
  grid-template-areas: 'stage panel' 'code code';
  margin: 8px 0 24px;
}
.mpr-pg.is-hero {
  display: block;
  width: 100%;
  margin: 0;
}
.stage {
  grid-area: stage;
  position: relative;
  align-self: start;
  border-radius: var(--pg-radius);
  overflow: hidden;
  background: linear-gradient(160deg, #dfe6fd, #eff0f5);
  box-shadow: var(--mpr-lift);
  height: clamp(420px, 78vh, 720px);
}
.is-full .stage {
  position: sticky;
  top: calc(var(--vp-nav-height, 64px) + 16px);
}
.is-hero .stage {
  min-height: 0;
  height: clamp(340px, 46vw, 480px);
  width: 100%;
}
.map {
  position: absolute;
  inset: 0;
}
.veil {
  position: absolute;
  left: 14px;
  top: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.86);
  color: #221e35;
  font-size: 13px;
  backdrop-filter: blur(6px);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2f5bea;
  animation: pulse 1.2s ease-in-out infinite;
}
.dot.error,
.dot.nowebgl {
  background: #d9534f;
  animation: none;
}
@keyframes pulse {
  50% { opacity: 0.3; }
}
@media (prefers-reduced-motion: reduce) {
  .dot { animation: none; }
}
.attrib {
  position: absolute;
  right: 10px;
  bottom: 8px;
  margin: 0;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.82);
  color: #221e35;
}
.log {
  position: absolute;
  left: 12px;
  bottom: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
  max-width: calc(100% - 24px);
}
.log li {
  font: 12px/1.4 var(--vp-font-family-mono);
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(30, 27, 44, 0.78);
  color: #e8e5f4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log li.warn { background: rgba(168, 101, 26, 0.9); }

.hero-bar {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.hero-bar .chips { background: rgba(255, 255, 255, 0.82); padding: 4px; border-radius: 10px; backdrop-filter: blur(6px); }
.hero-bar .open {
  margin-left: auto;
  font-size: 13px;
  font-weight: 600;
  padding: 7px 12px;
  border-radius: 10px;
  background: #2f5bea;
  color: #fff;
  text-decoration: none;
}

.panel {
  grid-area: panel;
  display: grid;
  gap: 12px;
  align-content: start;
}
fieldset {
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 10px 14px 12px;
  background: var(--vp-c-bg);
  display: grid;
  gap: 8px;
}
legend {
  font-family: var(--mpr-display);
  font-size: 16px;
  padding: 0 6px;
  margin-left: -6px;
}
.row {
  display: grid;
  grid-template-columns: 84px 1fr auto;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
select,
input[type='range'] {
  width: 100%;
  min-width: 0;
}
select {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 5px 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
}
output {
  font: 12px var(--vp-font-family-mono);
  min-width: 28px;
  text-align: right;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chips button,
.actions button,
.chain .add,
.copy,
.tabs button {
  font: 500 12px/1 var(--vp-font-family-mono);
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  cursor: pointer;
}
.chips button[aria-pressed='true'],
.tabs button[aria-selected='true'],
.actions .primary {
  background: #2f5bea;
  border-color: #2f5bea;
  color: #fff;
}
.hero-bar .chips button { border-color: transparent; background: transparent; color: #221e35; }
.hero-bar .chips button[aria-pressed='true'] { background: #2f5bea; color: #fff; }
button:disabled { opacity: 0.45; cursor: default; }
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid #2f5bea;
  outline-offset: 2px;
}
.toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 13px;
}
.chain {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.slot {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.slot select { width: auto; }
.slot + .slot::before,
.slot + .add::before {
  content: '→';
  color: var(--vp-c-text-3);
  margin-right: 4px;
}
.x {
  border: 0;
  background: transparent;
  color: var(--vp-c-text-3);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}
.actions {
  display: flex;
  gap: 6px;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.unsupported {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(227, 162, 59, 0.14);
  color: var(--mpr-mod);
}

.code {
  grid-area: code;
  border-radius: var(--pg-radius);
  background: #1e1b2c;
  color: #e8e5f4;
  overflow: hidden;
}
.code-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-wrap: wrap;
}
.tabs { display: flex; gap: 4px; }
.tabs button,
.copy { background: transparent; border-color: rgba(255, 255, 255, 0.14); color: #e8e5f4; }
.inline { font-size: 12px; color: #8f8bab; }
.copy { margin-left: auto; }
pre {
  margin: 0;
  padding: 14px 16px 18px;
  overflow-x: auto;
  font: 13px/1.6 var(--vp-font-family-mono);
  max-height: 520px;
}
pre :deep(.tok-c) { color: #8f8baa; }
pre :deep(.tok-s) { color: #ffcb7d; }
pre :deep(.tok-k) { color: #a9bbff; }
pre :deep(.tok-n) { color: #f6a9c9; }
pre :deep(.tok-t) { color: #8fe0c6; }

@media (max-width: 960px) {
  .mpr-pg {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'stage' 'panel' 'code';
  }
  .is-full .stage { position: relative; top: auto; height: 62vh; }
}
</style>
