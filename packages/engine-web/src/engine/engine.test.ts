import {
  ENGINE_COMMAND_TYPES,
  REQUEST_METHODS,
  SUBSCRIPTION_TOPICS,
  validateEngineCommand,
  type EngineCommand,
  type EngineCommandType,
  type EngineEvent,
  type RequestCommand,
} from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { NOT_IMPLEMENTED, UNSUPPORTED } from '../bridge/dispatcher.js';
import { createDirectTransport } from '../bridge/transport.js';
import { Engine } from './engine.js';

/** Just enough DOM for the engine shell to construct in node (WebGL creation then fails gracefully). */
function fakeDom(): HTMLElement {
  const doc: Record<string, unknown> = {};
  const el = (tag: string): Record<string, unknown> => {
    const e: Record<string, unknown> = {
      tagName: tag.toUpperCase(), style: {}, dataset: {}, hidden: false, className: '', ownerDocument: doc,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, appendChild: (c: unknown) => c, append() {}, remove() {}, addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ width: 390, height: 760, left: 0, top: 0 }), getContext: () => null,
    };
    return e;
  };
  Object.assign(doc, {
    defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ position: 'relative' }), addEventListener() {}, removeEventListener() {} },
    createElement: el, getElementById: () => null, head: el('head'),
  });
  return el('div') as unknown as HTMLElement;
}

const c = { lng: 127, lat: 37.5 };
const samples: Record<Exclude<EngineCommandType, 'request'>, EngineCommand[]> = {
  init: [{ type: 'init', world: { kind: 'procedural', layout: 'grid' }, theme: {}, labels: {}, ui: {}, locationSource: 'simulated' }],
  setTheme: [{ type: 'setTheme', theme: { base: 'toy' } }],
  setLabels: [{ type: 'setLabels', labels: { style: 'holo', icons: 'auto', content: 'custom' } }],
  setLabelContent: [{ type: 'setLabelContent', entries: { 'poi:x': { title: 'X' } } }],
  setUi: [{ type: 'setUi', ui: { locationPuck: true, scaleBar: true, zoomButtons: true, attribution: true } }],
  setCamera: [{ type: 'setCamera', camera: { center: c, distance: 300 } }],
  upsertCharacters: [{ type: 'upsertCharacters', characters: [{ id: 'me', isPlayer: true }] }],
  removeCharacters: [{ type: 'removeCharacters', ids: ['me'] }],
  setLocationSource: [{ type: 'setLocationSource', source: 'external' }],
  pushLocation: [{ type: 'pushLocation', fix: { ...c, timestamp: 0 } }],
  travel: [{ type: 'travel', requestId: 't', characterId: 'me', to: c, modes: ['walk', 'car', 'walk'] }],
  cancelTravel: [{ type: 'cancelTravel', characterId: 'me' }],
  setDropLayer: [{ type: 'setDropLayer', layerId: 'l', drops: [{ id: 'd', type: 'cd', coordinate: c, rarity: 'legendary' }], collectRadiusMeters: 10 }],
  removeDropLayer: [{ type: 'removeDropLayer', layerId: 'l' }],
  setMarkerLayer: [
    {
      type: 'setMarkerLayer',
      layerId: 'poi',
      markers: [
        { id: 'm1', coordinate: c, color: '#2F5BEA', priority: 1, accessibilityLabel: 'One, Blue' },
        { id: 'm2', coordinate: c, icon: { uri: 'data:image/svg+xml;base64,PHN2Zy8+' }, alwaysVisible: true },
      ],
      selectedId: 'm1',
      selectedScale: 1.25,
      size: 36,
      anchor: 'bottom',
    },
  ],
  removeMarkerLayer: [{ type: 'removeMarkerLayer', layerId: 'poi' }],
  setInfoCard: [
    {
      type: 'setInfoCard',
      card: {
        id: 'poi-1',
        coordinate: c,
        anchor: 'auto',
        dismissible: true,
        content: {
          title: '스타벅스 판교점',
          subtitle: '카페',
          icon: 'cafe',
          badges: [{ text: '영업 중', tone: 'good' }],
          rating: { value: 4.3, count: 1281 },
          rows: [{ icon: 'hours', text: '22:00 영업 종료' }],
          actions: [{ id: 'route', label: '길찾기', primary: true }],
        },
      },
    },
  ],
  removeInfoCard: [{ type: 'removeInfoCard', id: 'poi-1' }],
  setView: [{ type: 'setView', view: '2d', animate: false }, { type: 'setView', view: '2.5d' }],
  setGeofences: [{ type: 'setGeofences', geofences: [{ id: 'g', center: c, radiusMeters: 50 }] }],
  setBuildingStyle: [{ type: 'setBuildingStyle', buildingId: 'b', style: null }],
  setOverlayAnchors: [{ type: 'setOverlayAnchors', anchors: [{ id: 'a', coordinate: c }] }],
  subscribe: SUBSCRIPTION_TOPICS.map((topic) => ({ type: 'subscribe', topic, throttleMs: 100 }) as EngineCommand),
  unsubscribe: SUBSCRIPTION_TOPICS.map((topic) => ({ type: 'unsubscribe', topic }) as EngineCommand),
};
const requests: RequestCommand[] = [
  { type: 'request', requestId: 'p', method: 'project', params: { coordinate: c } },
  { type: 'request', requestId: 'u', method: 'unproject', params: { x: 10, y: 10 } },
  { type: 'request', requestId: 's', method: 'snapToRoad', params: { coordinate: c } },
  { type: 'request', requestId: 'r', method: 'route', params: { from: c, to: c, modes: ['subway'] } },
  {
    type: 'request',
    requestId: 'f',
    method: 'fitBounds',
    params: { bounds: { sw: c, ne: { lng: c.lng + 0.01, lat: c.lat + 0.01 } }, padding: 24 },
  },
  { type: 'request', requestId: 'o', method: 'focusOn', params: { coordinate: c, heightMeters: 30 } },
];

describe('engine handler coverage', () => {
  it('registers a handler for every protocol command, request method and subscription topic', async () => {
    const transport = createDirectTransport();
    const engine = new Engine(fakeDom(), { transport });
    const events: EngineEvent[] = [];
    engine.on('*', (e) => events.push(e));
    expect(engine.dispatcher.unimplemented()).toEqual([]);
    for (const m of REQUEST_METHODS) expect(engine.dispatcher.has(m)).toBe(true);
    expect(requests.map((r) => r.method).sort()).toEqual([...REQUEST_METHODS].sort());

    const all: EngineCommand[] = [];
    for (const type of ENGINE_COMMAND_TYPES) {
      if (type === 'request') { all.push(...requests); continue; }
      const list = samples[type];
      expect(list.length, `sample for ${type}`).toBeGreaterThan(0);
      all.push(...list);
    }
    for (const cmd of all) {
      expect(validateEngineCommand(cmd), JSON.stringify(cmd)).toEqual({ ok: true });
      await engine.dispatch(cmd);
    }
    await new Promise((r) => setTimeout(r, 0));
    const codes = events.flatMap((e) => (e.type === 'error' ? [e.code] : e.type === 'response' && !e.ok ? [e.error.code] : []));
    expect(codes.length).toBeGreaterThan(0); // WebGL is unavailable in node: handlers run and fail with their own codes
    expect(codes).not.toContain(UNSUPPORTED);
    expect(codes).not.toContain(NOT_IMPLEMENTED);
    const responses = events.filter((e) => e.type === 'response');
    expect(responses.map((r) => (r as { requestId: string }).requestId).sort()).toEqual(['f', 'o', 'p', 'r', 's', 'u']);
    engine.destroy();
  });
});

describe('setCamera follow', () => {
  it('rejects following an unknown character with unknown_character', async () => {
    const transport = createDirectTransport();
    const engine = new Engine(fakeDom(), { transport });
    const errors: { code: string; message: string }[] = [];
    await new Promise((r) => setTimeout(r, 0)); // construction reports webgl_unavailable in node: not part of this check
    engine.on('*', (e) => { if (e.type === 'error') errors.push({ code: e.code, message: e.message }); });
    await engine.dispatch({ type: 'setCamera', camera: { follow: 'ghost' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('unknown_character');
    expect(errors[0]!.message).toContain('ghost');
    expect(errors.map((e) => e.code)).not.toContain(UNSUPPORTED);
    engine.destroy();
  });
});
