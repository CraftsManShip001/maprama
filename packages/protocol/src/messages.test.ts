import { describe, expect, it } from 'vitest';
import {
  ENGINE_COMMAND_TYPES,
  ENGINE_EVENT_TYPES,
  PROTOCOL_VERSION,
  PRESETS,
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  validateEngineCommand,
  validateEngineEvent,
  type EngineCommand,
  type EngineCommandType,
  type EngineEvent,
  type EngineEventType,
} from './index.js';
import { sampleWorld } from './__fixtures__/world.js';

const here = { lng: 126.978, lat: 37.5665 };
const there = { lng: 126.99, lat: 37.57 };

type CommandFixtures = { [K in EngineCommandType]: Extract<EngineCommand, { type: K }>[] };
type EventFixtures = { [K in EngineEventType]: Extract<EngineEvent, { type: K }>[] };

const commands: CommandFixtures = {
  init: [
    {
      type: 'init',
      world: { kind: 'procedural', layout: 'town', seed: 11 },
      theme: { base: 'urban', timeOfDay: 'golden' },
      labels: { enabled: true, style: 'holo', icons: 'auto', content: 'nameAndType' },
      ui: { locationPuck: true, scaleBar: true, zoomButtons: false, attribution: true },
      camera: { center: here, distance: 240, pitch: 50, bearing: 0, follow: 'me', animate: { durationMs: 300 } },
      locationSource: 'simulated',
    },
    {
      type: 'init',
      world: { kind: 'data', world: sampleWorld() },
      theme: { base: PRESETS.soft, cinematic: true },
      labels: {},
      ui: {},
      locationSource: 'device',
    },
    {
      type: 'init',
      world: { kind: 'url', url: 'https://cdn.example.com/seoul.json' },
      theme: {},
      labels: { content: 'custom' },
      ui: {},
      locationSource: 'external',
    },
  ],
  setTheme: [
    {
      type: 'setTheme',
      theme: {
        base: 'toy',
        shadows: false,
        buildings: { facade: false, outline: true, massing: 'varied', details: true, heightScale: 1.2 },
        roads: { laneMarkings: false, crosswalks: true },
        street: { props: true, parked: true, traffic: false },
        zoomOut: 'mapColors',
      },
    },
  ],
  setLabels: [{ type: 'setLabels', labels: { style: 'sticker' } }],
  setLabelContent: [
    {
      type: 'setLabelContent',
      entries: { 'poi:p1': { title: 'Blue Bottle', subtitle: 'Coffee', icon: 'cafe' }, 'road:r1': { title: 'Sejong-daero', icon: 'avenue' } },
    },
  ],
  setUi: [{ type: 'setUi', ui: { zoomButtons: true } }],
  setCamera: [
    { type: 'setCamera', camera: { zoom: 16, animate: true } },
    { type: 'setCamera', camera: { follow: null } },
  ],
  upsertCharacters: [
    {
      type: 'upsertCharacters',
      characters: [
        {
          id: 'me',
          model: { uri: 'https://example.com/hero.glb' },
          name: 'Hero',
          color: '#2F5BEA',
          position: here,
          follow: 'location',
          isPlayer: true,
          scale: 1.2,
          animations: { walk: 'Walking', idle: 'Idle_A' },
          showNameTag: true,
        },
        { id: 'npc-1' },
        { id: 'npc-2', model: null },
      ],
    },
  ],
  removeCharacters: [{ type: 'removeCharacters', ids: ['npc-1'] }],
  setLocationSource: [{ type: 'setLocationSource', source: 'external' }],
  pushLocation: [
    { type: 'pushLocation', fix: { lng: here.lng, lat: here.lat, accuracyMeters: 5, headingDeg: 90, speedMps: 1.4, timestamp: 1757900000000 } },
    { type: 'pushLocation', fix: { lng: 0, lat: 0, timestamp: 0 } },
  ],
  travel: [{ type: 'travel', requestId: 't1', characterId: 'me', to: there, modes: ['walk', 'car', 'walk'] }],
  cancelTravel: [{ type: 'cancelTravel', characterId: 'me' }],
  setDropLayer: [
    {
      type: 'setDropLayer',
      layerId: 'music',
      collectRadiusMeters: 15,
      collectorIds: ['me'],
      drops: [
        { id: 'd1', type: 'coin', coordinate: there, rarity: 'common', value: 10 },
        { id: 'd2', type: 'model', model: { uri: 'asset:/gem.glb' }, coordinate: here, rarity: 'legendary', payload: { track: 'x', tags: ['a', 1, null, true] } },
      ],
    },
    { type: 'setDropLayer', layerId: 'empty', collectRadiusMeters: 0, drops: [] },
  ],
  removeDropLayer: [{ type: 'removeDropLayer', layerId: 'music' }],
  setGeofences: [{ type: 'setGeofences', geofences: [{ id: 'g1', center: here, radiusMeters: 100 }] }],
  setBuildingStyle: [
    {
      type: 'setBuildingStyle',
      buildingId: 'b1',
      style: {
        color: '#FF8800',
        roof: 'dome',
        facade: false,
        decorations: ['sign', 'antenna', 'trees'],
        massing: 'box',
        replaceModel: { uri: 'https://example.com/castle.glb' },
        state: 'captured',
      },
    },
    { type: 'setBuildingStyle', buildingId: 'b1', style: null },
  ],
  setOverlayAnchors: [{ type: 'setOverlayAnchors', anchors: [{ id: 'o1', coordinate: here }] }],
  subscribe: [
    { type: 'subscribe', topic: 'character:position', id: 'me', throttleMs: 100 },
    { type: 'subscribe', topic: 'camera:change', throttleMs: 0 },
  ],
  unsubscribe: [{ type: 'unsubscribe', topic: 'travel:progress', id: 'me' }],
  request: [
    { type: 'request', requestId: 'q1', method: 'project', params: { coordinate: here } },
    { type: 'request', requestId: 'q2', method: 'unproject', params: { x: 100, y: 200 } },
    { type: 'request', requestId: 'q3', method: 'snapToRoad', params: { coordinate: here, maxDistanceMeters: 30 } },
    { type: 'request', requestId: 'q4', method: 'route', params: { from: here, to: there, modes: ['subway'] } },
  ],
};

const events: EventFixtures = {
  ready: [{ type: 'ready', engine: { name: '@diorama/engine-web', version: '0.0.0', kind: 'web' } }],
  error: [{ type: 'error', code: 'model_load_failed', message: 'GLB 404', fatal: false }],
  labelsIndex: [
    {
      type: 'labelsIndex',
      labels: [
        { id: 'poi:p1', kind: 'poi', name: 'Cafe', category: 'cafe', subtitle: 'Cafe', lngLat: here },
        { id: 'road:r1', kind: 'road', name: 'Main St', lngLat: there },
      ],
    },
  ],
  'map:press': [{ type: 'map:press', coordinate: here }],
  'building:press': [{ type: 'building:press', buildingId: 'b1', coordinate: here }],
  'drop:collect': [{ type: 'drop:collect', layerId: 'music', dropId: 'd1', characterId: 'me', coordinate: there, collectId: 'c-3f9a' }],
  'travel:start': [
    { type: 'travel:start', requestId: 't1', characterId: 'me', legs: [{ mode: 'walk', meters: 120 }, { mode: 'subway', meters: 3400 }, { mode: 'walk', meters: 80 }] },
  ],
  'travel:progress': [{ type: 'travel:progress', requestId: 't1', characterId: 'me', remainingMeters: 900, etaSeconds: 54, mode: 'subway' }],
  'travel:arrive': [{ type: 'travel:arrive', requestId: 't1', characterId: 'me' }],
  'travel:cancel': [{ type: 'travel:cancel', requestId: 't1', characterId: 'me' }],
  'geofence:enter': [{ type: 'geofence:enter', geofenceId: 'g1', characterId: 'me' }],
  'geofence:exit': [{ type: 'geofence:exit', geofenceId: 'g1', characterId: 'me' }],
  'character:position': [{ type: 'character:position', id: 'me', coordinate: here, headingDeg: 270, speedMps: 1.3 }],
  'camera:change': [{ type: 'camera:change', camera: { center: here, distance: 300, pitch: 45, bearing: -30 } }],
  'overlay:positions': [{ type: 'overlay:positions', positions: [{ id: 'o1', x: 12.5, y: 300, visible: true }] }],
  response: [
    { type: 'response', requestId: 'q1', ok: true, result: { x: 1, y: 2, visible: true } },
    { type: 'response', requestId: 'q2', ok: true, result: { coordinate: null } },
    { type: 'response', requestId: 'q3', ok: true, result: null },
    {
      type: 'response',
      requestId: 'q4',
      ok: true,
      result: { legs: [{ mode: 'walk', meters: 10, path: [here, there] }], meters: 10, etaSeconds: 7.5 },
    },
    { type: 'response', requestId: 'q5', ok: false, error: { code: 'unsupported', message: 'route not implemented' } },
  ],
};

describe('fixtures cover the protocol', () => {
  it('has fixtures for every command and event type', () => {
    expect(Object.keys(commands).sort()).toEqual([...ENGINE_COMMAND_TYPES].sort());
    expect(Object.keys(events).sort()).toEqual([...ENGINE_EVENT_TYPES].sort());
    expect(ENGINE_COMMAND_TYPES).toHaveLength(20);
    expect(ENGINE_EVENT_TYPES).toHaveLength(16);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('command round-trip', () => {
  let seq = 0;
  for (const type of ENGINE_COMMAND_TYPES) {
    it(`encodes and decodes "${type}"`, () => {
      for (const cmd of commands[type]) {
        const s = seq++;
        const wire = encodeCommand(cmd, s);
        expect(typeof wire).toBe('string');
        const decoded = decodeCommand(wire);
        if (!decoded.ok) throw new Error(decoded.error);
        expect(decoded.value).toEqual({ v: 1, seq: s, kind: 'cmd', msg: cmd });
        expect(validateEngineCommand(cmd)).toEqual({ ok: true });
      }
    });
  }
});

describe('event round-trip', () => {
  let seq = 1000;
  for (const type of ENGINE_EVENT_TYPES) {
    it(`encodes and decodes "${type}"`, () => {
      for (const evt of events[type]) {
        const s = seq++;
        const decoded = decodeEvent(encodeEvent(evt, s));
        if (!decoded.ok) throw new Error(decoded.error);
        expect(decoded.value).toEqual({ v: 1, seq: s, kind: 'evt', msg: evt });
        expect(validateEngineEvent(evt)).toEqual({ ok: true });
      }
    });
  }
});

function env(msg: unknown, over: Record<string, unknown> = {}, kind = 'cmd'): string {
  return JSON.stringify({ v: 1, seq: 1, kind, msg, ...over });
}

function expectReject(result: { ok: boolean; error?: string }, pathPrefix?: string): void {
  expect(result.ok).toBe(false);
  if (pathPrefix !== undefined) expect((result as { error: string }).error.startsWith(pathPrefix)).toBe(true);
}

describe('rejects malformed messages without throwing', () => {
  const travel = { type: 'travel', requestId: 't', characterId: 'me', to: here, modes: ['walk'] };

  it('rejects non-JSON and non-string input', () => {
    expectReject(decodeCommand('{not json'), '$: invalid JSON');
    expectReject(decodeCommand(''), '$: invalid JSON');
    expectReject(decodeCommand(42 as unknown as string), '$: expected JSON string');
    expectReject(decodeEvent(undefined as unknown as string), '$: expected JSON string');
  });

  it('rejects bad envelopes', () => {
    expectReject(decodeCommand('null'), '$: expected envelope object');
    expectReject(decodeCommand('[]'), '$: expected envelope object');
    expectReject(decodeCommand(env(travel, { v: 2 })), '$.v');
    expectReject(decodeCommand(JSON.stringify({ seq: 1, kind: 'cmd', msg: travel })), '$.v');
    expectReject(decodeCommand(env(travel, { kind: 'evt' })), '$.kind');
    expectReject(decodeCommand(env(travel, { kind: 'x' })), '$.kind');
    expectReject(decodeCommand(env(travel, { seq: -1 })), '$.seq');
    expectReject(decodeCommand(env(travel, { seq: 1.5 })), '$.seq');
    expectReject(decodeCommand(env(travel, { seq: '1' })), '$.seq');
    expectReject(decodeCommand(JSON.stringify({ v: 1, kind: 'cmd', msg: travel })), '$.seq');
    expectReject(decodeCommand(JSON.stringify({ v: 1, seq: 0, kind: 'cmd' })), '$.msg');
    expectReject(decodeEvent(encodeCommand(travel as EngineCommand, 1)), '$.kind');
  });

  it('rejects unknown or missing message types', () => {
    expectReject(decodeCommand(env({ type: 'explode' })), '$.msg.type: unknown type');
    expectReject(decodeCommand(env({ type: 7 })), '$.msg.type');
    expectReject(decodeCommand(env({})), '$.msg.type');
    expectReject(decodeCommand(env('travel')), '$.msg');
    expectReject(decodeEvent(env({ type: 'travel' }, {}, 'evt')), '$.msg.type: unknown type');
    expectReject(decodeCommand(env({ type: 'toString' })), '$.msg.type: unknown type');
    expectReject(decodeCommand(env({ type: '__proto__' })), '$.msg.type: unknown type');
  });

  it('rejects missing or mistyped required fields', () => {
    const cases: [unknown, string][] = [
      [{ ...travel, modes: undefined }, '$.msg.modes'],
      [{ ...travel, modes: [] }, '$.msg.modes'],
      [{ ...travel, modes: ['teleport'] }, '$.msg.modes[0]'],
      [{ ...travel, to: { lng: 'x', lat: 1 } }, '$.msg.to.lng'],
      [{ ...travel, to: { lng: 1, lat: 95 } }, '$.msg.to.lat'],
      [{ ...travel, requestId: '' }, '$.msg.requestId'],
      [{ type: 'pushLocation', fix: { lng: 1, lat: 2 } }, '$.msg.fix.timestamp'],
      [{ type: 'pushLocation', fix: { lng: 1, lat: 'n', timestamp: 1 } }, '$.msg.fix.lat'],
      [{ type: 'setBuildingStyle', buildingId: 'b1' }, '$.msg.style'],
      [{ type: 'setBuildingStyle', buildingId: 'b1', style: { roof: 'spire' } }, '$.msg.style.roof'],
      [{ type: 'setBuildingStyle', buildingId: 'b1', style: { color: 'red' } }, '$.msg.style.color'],
      [{ type: 'setDropLayer', layerId: 'l', collectRadiusMeters: 5, drops: [{ id: 'd', type: 'model', coordinate: here }] }, '$.msg.drops[0].model'],
      [{ type: 'setDropLayer', layerId: 'l', collectRadiusMeters: -1, drops: [] }, '$.msg.collectRadiusMeters'],
      [{ type: 'setDropLayer', layerId: 'l', collectRadiusMeters: 1, drops: [{ id: 'd', type: 'coin', coordinate: here, rarity: 'epic' }] }, '$.msg.drops[0].rarity'],
      [{ type: 'subscribe', topic: 'fps', throttleMs: 10 }, '$.msg.topic'],
      [{ type: 'subscribe', topic: 'camera:change' }, '$.msg.throttleMs'],
      [{ type: 'request', requestId: 'q', method: 'teleport', params: {} }, '$.msg.method'],
      [{ type: 'request', requestId: 'q', method: 'project', params: { x: 1, y: 2 } }, '$.msg.params.coordinate'],
      [{ type: 'request', requestId: 'q', method: 'route', params: { from: here, to: there, modes: [] } }, '$.msg.params.modes'],
      [{ type: 'init', world: { kind: 'procedural', layout: 'grid' }, theme: {}, labels: {}, ui: {} }, '$.msg.locationSource'],
      [{ type: 'init', world: { kind: 'maze' }, theme: {}, labels: {}, ui: {}, locationSource: 'device' }, '$.msg.world.kind'],
      [{ type: 'init', world: { kind: 'grid' }, theme: { base: 'neon' }, labels: {}, ui: {}, locationSource: 'device' }, '$.msg.world.kind'],
      [{ type: 'setTheme', theme: { base: 'neon' } }, '$.msg.theme.base'],
      [{ type: 'setLabels', labels: { style: 'comic' } }, '$.msg.labels.style'],
      [{ type: 'setLabelContent', entries: { a: { subtitle: 'x' } } }, '$.msg.entries["a"].title'],
      [{ type: 'upsertCharacters', characters: [{ name: 'no id' }] }, '$.msg.characters[0].id'],
      [{ type: 'upsertCharacters', characters: [{ id: 'a', scale: 0 }] }, '$.msg.characters[0].scale'],
      [{ type: 'setCamera', camera: { pitch: 120 } }, '$.msg.camera.pitch'],
      [{ type: 'setCamera', camera: { animate: 'slow' } }, '$.msg.camera.animate'],
      [{ type: 'setGeofences', geofences: [{ id: 'g', center: here, radiusMeters: 0 }] }, '$.msg.geofences[0].radiusMeters'],
      [{ type: 'removeCharacters', ids: 'me' }, '$.msg.ids'],
    ];
    for (const [msg, path] of cases) {
      const r = decodeCommand(env(msg));
      expect(r.ok, `expected rejection for ${JSON.stringify(msg)}`).toBe(false);
      if (!r.ok) expect(r.error.startsWith(path), `error "${r.error}" should start with ${path}`).toBe(true);
      expect(validateEngineCommand(msg).ok).toBe(false);
    }
  });

  it('rejects malformed events', () => {
    const cases: [unknown, string][] = [
      [{ type: 'ready', engine: { name: 'x', version: '1', kind: 'wasm' } }, '$.msg.engine.kind'],
      [{ type: 'error', code: 'internal', message: 'boom', fatal: 'yes' }, '$.msg.fatal'],
      [{ type: 'drop:collect', layerId: 'l', dropId: 'd', characterId: 'me', coordinate: here }, '$.msg.collectId'],
      [{ type: 'travel:progress', requestId: 't', characterId: 'me', remainingMeters: 1, etaSeconds: 1, mode: 'boat' }, '$.msg.mode'],
      [{ type: 'camera:change', camera: { center: here, distance: 1, pitch: 1 } }, '$.msg.camera.bearing'],
      [{ type: 'overlay:positions', positions: [{ id: 'o', x: 1, y: 2 }] }, '$.msg.positions[0].visible'],
      [{ type: 'labelsIndex', labels: [{ id: 'l', kind: 'shop', name: 'x', lngLat: here }] }, '$.msg.labels[0].kind'],
      [{ type: 'response', requestId: 'q', ok: true }, '$.msg.result'],
      [{ type: 'response', requestId: 'q', ok: false }, '$.msg.error'],
      [{ type: 'response', requestId: 'q', ok: 'true', result: 1 }, '$.msg.ok'],
    ];
    for (const [msg, path] of cases) {
      const r = decodeEvent(env(msg, {}, 'evt'));
      expect(r.ok, `expected rejection for ${JSON.stringify(msg)}`).toBe(false);
      if (!r.ok) expect(r.error.startsWith(path), `error "${r.error}" should start with ${path}`).toBe(true);
    }
  });

  it('rejects excessively deep payloads and non-finite numbers', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    const msg = { type: 'setDropLayer', layerId: 'l', collectRadiusMeters: 1, drops: [{ id: 'd', type: 'coin', coordinate: here, payload: deep }] };
    expectReject(decodeCommand(env(msg)), '$.msg.drops[0].payload');
    expect(validateEngineCommand({ ...travel, to: { lng: Number.NaN, lat: 0 } }).ok).toBe(false);
  });

  it('allows unknown extra fields (forward compatibility)', () => {
    const r = decodeCommand(env({ ...travel, futureField: { a: 1 } }, { trace: 'abc' }));
    expect(r.ok).toBe(true);
  });

  it('never throws on arbitrary input', () => {
    const inputs = [
      '0', 'true', '"str"', '{}', '{"v":1}', '{"v":1,"seq":0,"kind":"cmd","msg":null}',
      '{"v":1,"seq":0,"kind":"cmd","msg":{"type":"request","requestId":"q","method":"route","params":null}}',
      '{"v":1,"seq":0,"kind":"evt","msg":{"type":"response","requestId":"q","ok":false,"error":null}}',
      '{"v":1,"seq":0,"kind":"cmd","msg":{"type":"init","world":null}}',
      '{"__proto__":{"v":1}}',
    ];
    for (const input of inputs) {
      expect(() => decodeCommand(input)).not.toThrow();
      expect(() => decodeEvent(input)).not.toThrow();
      expect(decodeCommand(input).ok).toBe(false);
      expect(decodeEvent(input).ok).toBe(false);
    }
    for (const v of [null, undefined, 0, 'x', [], {}, { type: null }]) {
      expect(() => validateEngineCommand(v)).not.toThrow();
      expect(() => validateEngineEvent(v)).not.toThrow();
    }
  });
});

describe('encode', () => {
  it('throws RangeError for an invalid seq', () => {
    const cmd: EngineCommand = { type: 'cancelTravel', characterId: 'me' };
    expect(() => encodeCommand(cmd, -1)).toThrow(RangeError);
    expect(() => encodeCommand(cmd, 0.5)).toThrow(RangeError);
    expect(() => encodeEvent({ type: 'travel:arrive', requestId: 't', characterId: 'me' }, Number.NaN)).toThrow(RangeError);
  });

  it('produces the documented envelope shape', () => {
    const wire = encodeCommand({ type: 'removeDropLayer', layerId: 'x' }, 3);
    expect(JSON.parse(wire)).toEqual({ v: 1, seq: 3, kind: 'cmd', msg: { type: 'removeDropLayer', layerId: 'x' } });
  });
});
