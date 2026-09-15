/**
 * Playground state → protocol commands, React Native JSX and theme JSON.
 *
 * Pure functions only (no DOM, no engine) so the page can render on the server.
 * Product names live in `BRAND`.
 */
import {
  DROP_TYPES,
  HOLO_ICON_TILES,
  LABEL_CONTENT_MODES,
  LABEL_STYLES,
  PRESETS,
  PRESET_NAMES,
  RARITIES,
  TIMES_OF_DAY,
  TRAVEL_MODES,
  ZOOM_OUT_BEHAVIORS,
} from '@maprama/protocol';
import type {
  DropType,
  HoloIconTile,
  LabelContent,
  LabelContentMode,
  LabelInfo,
  LabelsSpec,
  PresetName,
  Rarity,
  ThemeSpec,
  TimeOfDay,
  TravelMode,
  WorldSource,
  ZoomOutBehavior,
  LabelStyle,
} from '@maprama/protocol';

export const BRAND = {
  name: 'Maprama',
  rnPackage: '@maprama/react-native',
  protocolPackage: '@maprama/protocol',
} as const;

export const OPTIONS = {
  presets: PRESET_NAMES,
  times: TIMES_OF_DAY,
  zoomOut: ZOOM_OUT_BEHAVIORS,
  labelStyles: LABEL_STYLES,
  labelIcons: HOLO_ICON_TILES,
  labelContent: LABEL_CONTENT_MODES,
  travelModes: TRAVEL_MODES,
  dropTypes: DROP_TYPES.filter((t) => t !== 'model') as DropType[],
  rarities: RARITIES,
  dropSources: ['data', 'service'] as DropSource[],
} as const;

/** `DropLayer` source shown in the JSX panel (the page itself always renders local demo drops). */
export type DropSource = 'data' | 'service';

export type WorldChoice = 'town' | 'grid' | 'sample' | 'seongsu';

export const WORLDS: { id: WorldChoice; label: string; note?: string }[] = [
  { id: 'town', label: '절차 생성 · 타운' },
  { id: 'grid', label: '절차 생성 · 격자' },
  { id: 'sample', label: '샘플 WorldData' },
  { id: 'seongsu', label: '성수동 (OSM)', note: '© OpenStreetMap contributors · ODbL 1.0' },
];

export interface PlaygroundState {
  world: WorldChoice;
  preset: PresetName;
  timeOfDay: TimeOfDay;
  zoomOut: ZoomOutBehavior;
  cinematic: boolean;
  massing: 'box' | 'varied';
  details: boolean;
  /** Camera distance in world units (the engine receives meters). */
  distance: number;
  labelsEnabled: boolean;
  labelStyle: LabelStyle;
  labelIcons: HoloIconTile;
  labelContent: LabelContentMode;
  travelModes: TravelMode[];
  dropType: DropType;
  dropRarity: Rarity;
  dropSource: DropSource;
}

export function defaultState(): PlaygroundState {
  return {
    world: 'town',
    preset: 'urban',
    timeOfDay: 'day',
    zoomOut: 'keepGameView',
    cinematic: false,
    massing: 'varied',
    details: false,
    distance: 48,
    labelsEnabled: true,
    labelStyle: 'holo',
    labelIcons: 'auto',
    labelContent: 'nameAndType',
    travelModes: ['walk', 'car', 'walk'],
    dropType: 'cd',
    dropRarity: 'rare',
    dropSource: 'data',
  };
}

/** Public URLs (relative to the site base) of the bundled sample worlds. */
export const WORLD_URLS = {
  sample: 'worlds/sample.world.json',
  seongsu: 'worlds/seongsu.world.json',
} as const;

export function worldSource(state: PlaygroundState, resolveUrl: (path: string) => string): WorldSource {
  if (state.world === 'town' || state.world === 'grid') return { kind: 'procedural', layout: state.world };
  return { kind: 'url', url: resolveUrl(WORLD_URLS[state.world]) };
}

export function themeSpec(state: PlaygroundState): ThemeSpec {
  const theme: ThemeSpec = { base: state.preset, timeOfDay: state.timeOfDay, zoomOut: state.zoomOut };
  if (state.cinematic) theme.cinematic = true;
  const buildings: NonNullable<ThemeSpec['buildings']> = { massing: state.massing };
  if (state.details) buildings.details = true;
  theme.buildings = buildings;
  return theme;
}

export function labelsSpec(state: PlaygroundState): LabelsSpec {
  return {
    enabled: state.labelsEnabled,
    style: state.labelStyle,
    icons: state.labelIcons,
    content: state.labelContent,
  };
}

/** Example host content used when `content: 'custom'` (what an app would compute from its own data). */
export function customLabelContent(label: LabelInfo): LabelContent {
  if (label.kind === 'poi' && label.category === 'music') return { title: label.name, subtitle: '오늘의 드롭 3곡', icon: 'music' };
  if (label.kind === 'poi' && label.category === 'cafe') return { title: label.name, subtitle: '쿠폰 드롭 진행 중', icon: 'cafe' };
  if (label.kind === 'road') return { title: label.name, subtitle: '내 위치에서 120 m' };
  return { title: label.name };
}

/** Theme JSON for export: the spec as-is, or with the preset object inlined as a custom `base`. */
export function themeJson(state: PlaygroundState, inlinePreset: boolean): string {
  const spec = themeSpec(state);
  const out: ThemeSpec = inlinePreset ? { ...spec, base: PRESETS[state.preset] } : spec;
  return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// JSX code panel
// ---------------------------------------------------------------------------

type Lit = string | number | boolean | Lit[] | { [k: string]: Lit | undefined };

/** Formats a value as a compact JS object literal (single quotes, unquoted keys). */
export function literal(value: Lit): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined) as [string, Lit][];
  if (!entries.length) return '{}';
  return `{ ${entries.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : literal(k)}: ${literal(v)}`).join(', ')} }`;
}

export function reactNativeJsx(state: PlaygroundState): string {
  const theme = themeSpec(state) as unknown as Lit;
  const custom = state.labelContent === 'custom';
  const labels: Lit = {
    enabled: state.labelsEnabled,
    style: state.labelStyle,
    icons: state.labelIcons,
    ...(custom ? {} : { content: state.labelContent }),
  };
  const world =
    state.world === 'town' || state.world === 'grid'
      ? literal({ kind: 'procedural', layout: state.world })
      : `{ kind: 'url', url: 'https://your-cdn.example/${state.world}.world.json' }`;
  const labelsProp = custom ? `${literal(labels).slice(0, -2)}, content: labelContent }` : literal(labels);
  const service = state.dropSource === 'service';
  const lines: string[] = [];
  lines.push(
    service
      ? `// userId, CLIENT_KEY, showSparkle, claimOnMyServer는 앱이 제공하는 값/함수예요`
      : `// Drop 타입과 verifyOnServer는 앱이 제공하는 타입/함수예요`,
  );
  lines.push(`import { useRef } from 'react';`);
  lines.push(`import { MapramaView, Character, DropLayer, type MapramaViewRef${custom ? ', type LabelInfo' : ''} } from '${BRAND.rnPackage}';`);
  lines.push('');
  lines.push(service ? `export function GameMap({ userId }: { userId: string }) {` : `export function GameMap({ drops }: { drops: Drop[] }) {`);
  lines.push(`  const map = useRef<MapramaViewRef>(null);`);
  if (custom) {
    lines.push(`  // 평가 시점: labelsIndex 수신, 함수가 아닌 labels 필드 변경, map.current?.refreshLabelContent() 호출`);
    lines.push(`  const labelContent = (label: LabelInfo) =>`);
    lines.push(`    label.category === 'music' ? { title: label.name, subtitle: '오늘의 드롭 3곡', icon: 'music' as const } : { title: label.name };`);
  }
  lines.push('');
  lines.push(`  return (`);
  lines.push(`    <MapramaView`);
  lines.push(`      ref={map}`);
  lines.push(`      world={${world}}`);
  lines.push(`      theme={${literal(theme)}}`);
  lines.push(`      labels={${labelsProp}}`);
  lines.push(`      camera={{ pitch: 40, bearing: 28, follow: 'me' }}`);
  lines.push(`      onPress={(e) => map.current?.travel('me', e.coordinate, ${literal(state.travelModes)})}`);
  lines.push(`      onError={(e) => console.warn(e.code, e.message)}`);
  lines.push(`      style={{ flex: 1 }}`);
  lines.push(`    >`);
  lines.push(`      <Character id="me" isPlayer name="나" color="#2F5BEA" showNameTag />`);
  if (service) {
    lines.push(`      {/* 드롭 종류와 희귀도는 캠페인(POST /v1/drops/campaigns)이 정해요 */}`);
    lines.push(`      <DropLayer`);
    lines.push(`        id="demo"`);
    lines.push(`        source="service"`);
    lines.push(`        channel="music"`);
    lines.push(`        apiKey={CLIENT_KEY}`);
    lines.push(`        baseUrl="https://api.example"`);
    lines.push(`        userId={userId}`);
    lines.push(`        collectRadiusMeters={15}`);
    lines.push(`        onCollect={(e) => showSparkle(e.payload)}`);
    lines.push(`        onCollectVerified={(e) => claimOnMyServer(e.receipt)}`);
    lines.push(`        onCollectRejected={(e) => console.warn(e.code, e.status)}`);
    lines.push(`      />`);
  } else {
    lines.push(`      <DropLayer`);
    lines.push(`        id="demo"`);
    lines.push(`        data={drops}`);
    lines.push(`        getId={(d) => d.id}`);
    lines.push(`        getCoordinate={(d) => d.coordinate}`);
    lines.push(`        getType={() => ${literal(state.dropType)}}`);
    lines.push(`        getRarity={() => ${literal(state.dropRarity)}}`);
    lines.push(`        collectRadiusMeters={15}`);
    lines.push(`        onCollect={(e) => verifyOnServer(e.collectId)}`);
    lines.push(`      />`);
  }
  lines.push(`    </MapramaView>`);
  lines.push(`  );`);
  lines.push(`}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Minimal TSX / JSON highlighter (escaped HTML with span classes)
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN =
  /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(import|from|export|function|const|return|type|as|true|false|null)\b|\b(\d+(?:\.\d+)?)\b|(<\/?[A-Z][A-Za-z]*)/g;

export function highlight(src: string): string {
  let out = '';
  let last = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    out += escapeHtml(src.slice(last, m.index));
    last = m.index + m[0].length;
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 'n' : 't';
    out += `<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
  }
  TOKEN.lastIndex = 0;
  return out + escapeHtml(src.slice(last));
}

// ---------------------------------------------------------------------------
// Engine error classification
// ---------------------------------------------------------------------------

/**
 * Control group an `unsupported` error belongs to. The current web engine
 * implements all of them; the classification stays so an engine build without
 * a feature (e.g. a future native engine milestone) degrades to a note.
 */
export type FeatureGroup = 'labels' | 'travel' | 'drops';

const COMMAND_GROUP: Record<string, FeatureGroup> = {
  setLabels: 'labels',
  setLabelContent: 'labels',
  upsertCharacters: 'travel',
  removeCharacters: 'travel',
  travel: 'travel',
  cancelTravel: 'travel',
  setDropLayer: 'drops',
  removeDropLayer: 'drops',
};

/** True for the protocol `unsupported` code and the engine's legacy `NOT_IMPLEMENTED`. */
export function isUnsupported(code: string): boolean {
  return code === 'unsupported' || code === 'NOT_IMPLEMENTED';
}

/** Feature group of an `unsupported` error, from the command name quoted in its message. */
export function groupOfUnsupported(message: string): FeatureGroup | null {
  const m = /(?:command|method|topic) "([^"]+)"/.exec(message) ?? /^([A-Za-z]+):/.exec(message);
  const name = m?.[1];
  return name ? COMMAND_GROUP[name] ?? null : null;
}
