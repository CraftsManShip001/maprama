#!/usr/bin/env node
/**
 * Exports golden conformance fixtures from the built `@maprama/protocol`
 * package (dist) into `cpp/tests/fixtures/`. The C++ core must reproduce every
 * expected value exactly (decode results and error strings) or within 1e-6
 * (projection math).
 *
 * Files written:
 * - protocol-meta.json   constants and enum lists (ENGINE_COMMAND_TYPES, ...)
 * - decode-command.json  decodeCommand(input) for valid samples, mutations and hand-written edge cases
 * - decode-event.json    decodeEvent(input) likewise
 * - world.json           validateWorldData(JSON.parse(input)) for a sample world and its mutations
 * - projection.json      createProjection samples (toWorld/toLngLat/...) and RangeError messages
 * - json-format.json     JS number/string/key-order formatting (JSON.stringify, String(number))
 *
 * Run `npm run build -w @maprama/protocol` first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '@maprama/protocol';

const outDir = fileURLToPath(new URL('../cpp/tests/fixtures/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const SENTINEL = '@@RAW@@';
/** Raw JSON tokens substituted at every mutated path (includes non-JSON.stringify-able `1e400`). */
const RAW_TOKENS = [
  'null',
  'true',
  '""',
  '"zzz"',
  '0',
  '-1',
  '0.5',
  '1e400',
  '[]',
  '{}',
  '16777216',
  '"#ABC"',
  '9007199254740993',
];

const clone = (v) => structuredClone(v);

/** Every path (array of keys/indices) to a value inside `value`, excluding the root. */
function paths(value, prefix = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      out.push([...prefix, i]);
      paths(item, [...prefix, i], out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.push([...prefix, key]);
      paths(value[key], [...prefix, key], out);
    }
  }
  return out;
}

function parentOf(root, path) {
  let node = root;
  for (const key of path.slice(0, -1)) node = node[key];
  return node;
}

/** JSON texts derived from `sample`: each path replaced by each raw token, deleted, or spliced out. */
function mutations(sample, { skip = () => false } = {}) {
  const out = [];
  for (const path of paths(sample)) {
    if (skip(path)) continue;
    const label = path.join('.');
    for (const raw of RAW_TOKENS) {
      const copy = clone(sample);
      parentOf(copy, path)[path.at(-1)] = SENTINEL;
      out.push({ label: `${label}=${raw}`, text: JSON.stringify(copy).replace(`"${SENTINEL}"`, raw) });
    }
    const copy = clone(sample);
    const parent = parentOf(copy, path);
    if (Array.isArray(parent)) parent.splice(path.at(-1), 1);
    else delete parent[path.at(-1)];
    out.push({ label: `${label} removed`, text: JSON.stringify(copy) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

const ll = { lng: 126.978, lat: 37.5665 };
const ll2 = { lng: 126.99, lat: 37.57 };

const world = {
  version: 1,
  name: 'fixture',
  origin: ll,
  unitMeters: 8,
  bounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 },
  roads: [{ id: 'r1', name: 'Main', cls: 'arterial', bridge: false, pts: [[0, 0], [5, 0]] }],
  buildings: [{ id: 'b1', footprint: [[0, 0], [1, 0], [1, 1]], height: 3, levels: 4, kind: 'glass', name: 'Tower' }],
  water: [[[0, 0], [1, 0], [1, 1]]],
  parks: [{ name: 'Park', poly: [[0, 0], [1, 0], [1, 1]] }],
  pois: [{ id: 'p1', name: 'Cafe', cat: 'cafe', x: 1, z: 2 }],
  stations: [{ id: 's1', name: 'Station', x: 3, z: 4 }],
  districts: [{ name: 'Jung-gu', x: 0, z: 0, water: false }],
  plaza: { x: 0, z: 0 },
  attribution: ['© OpenStreetMap contributors'],
};

const commandSamples = {
  init: {
    type: 'init',
    world: { kind: 'data', world },
    theme: {
      base: 'toy',
      timeOfDay: 'dusk',
      cinematic: true,
      shadows: false,
      buildings: { facade: true, outline: false, massing: 'varied', details: true, heightScale: 1.5 },
      roads: { laneMarkings: true, crosswalks: false },
      street: { props: true, parked: false, traffic: true },
      zoomOut: 'keepGameView',
    },
    labels: { enabled: true, style: 'holo', icons: 'auto', content: 'custom' },
    ui: { locationPuck: true, scaleBar: false, zoomButtons: true, attribution: true },
    camera: { center: ll, distance: 120, zoom: 16, pitch: 45, bearing: 30, follow: 'player', animate: { durationMs: 300 } },
    locationSource: 'simulated',
  },
  init_url: {
    type: 'init',
    world: { kind: 'url', url: 'https://example.com/world.json' },
    theme: {},
    labels: {},
    ui: {},
    locationSource: 'device',
  },
  init_procedural: {
    type: 'init',
    world: { kind: 'procedural', layout: 'town', seed: 42 },
    theme: { base: 'minimal' },
    labels: {},
    ui: {},
    camera: { follow: null, animate: true },
    locationSource: 'external',
  },
  setTheme_custom: { type: 'setTheme', theme: { base: clone(P.PRESETS.realistic), timeOfDay: 'night' } },
  setLabels: { type: 'setLabels', labels: { enabled: false, style: 'sign', icons: 'color', content: 'nameAndType' } },
  setLabelContent: {
    type: 'setLabelContent',
    entries: { 'poi:p1': { title: 'Cafe', subtitle: 'Coffee', icon: 'cafe' }, 2: { title: 'Two', icon: 'avenue' } },
  },
  setUi: { type: 'setUi', ui: { scaleBar: true } },
  setCamera: { type: 'setCamera', camera: { center: ll, pitch: 0, bearing: -90, animate: false } },
  upsertCharacters: {
    type: 'upsertCharacters',
    characters: [
      {
        id: 'player',
        model: { uri: 'asset://avatar.glb' },
        name: 'Me',
        color: '#2F5BEA',
        position: ll,
        follow: 'location',
        isPlayer: true,
        scale: 1,
        animations: { idle: 'Idle', walk: 'Walk', run: 'Run', ride: 'Ride', wave: 'Wave' },
        showNameTag: true,
      },
      { id: 'npc', color: '#abc', follow: 'none' },
      { id: 'back-to-default', model: null },
    ],
  },
  removeCharacters: { type: 'removeCharacters', ids: ['a', 'b'] },
  setLocationSource: { type: 'setLocationSource', source: 'external' },
  pushLocation: {
    type: 'pushLocation',
    fix: { lng: 126.978, lat: 37.5665, accuracyMeters: 5, headingDeg: 90, speedMps: 1.2, timestamp: 1700000000000 },
  },
  travel: { type: 'travel', requestId: 't1', characterId: 'player', to: ll2, modes: ['walk', 'subway'], timeScale: 20 },
  cancelTravel: { type: 'cancelTravel', characterId: 'player' },
  setDropLayer: {
    type: 'setDropLayer',
    layerId: 'l1',
    drops: [
      {
        id: 'd1',
        type: 'model',
        model: { uri: 'drop.glb' },
        coordinate: ll,
        rarity: 'rare',
        value: 10,
        payload: { a: [1, 'x', null, true, { b: 2 }] },
      },
      { id: 'd2', type: 'coin', coordinate: ll2 },
    ],
    collectRadiusMeters: 15,
    collectorIds: ['player'],
  },
  removeDropLayer: { type: 'removeDropLayer', layerId: 'l1' },
  setGeofences: { type: 'setGeofences', geofences: [{ id: 'g1', center: ll, radiusMeters: 50 }] },
  setBuildingStyle: {
    type: 'setBuildingStyle',
    buildingId: 'b1',
    style: {
      color: '#FF8800',
      roof: 'gable',
      facade: false,
      decorations: ['sign', 'trees'],
      massing: 'box',
      replaceModel: { uri: 'building.glb' },
      state: 'captured',
    },
  },
  setBuildingStyle_null: { type: 'setBuildingStyle', buildingId: 'b1', style: null },
  setOverlayAnchors: { type: 'setOverlayAnchors', anchors: [{ id: 'o1', coordinate: ll }] },
  subscribe: { type: 'subscribe', topic: 'character:position', id: 'player', throttleMs: 100 },
  unsubscribe: { type: 'unsubscribe', topic: 'camera:change' },
  request_project: { type: 'request', requestId: 'q1', method: 'project', params: { coordinate: ll } },
  request_unproject: { type: 'request', requestId: 'q2', method: 'unproject', params: { x: 10, y: 20 } },
  request_snapToRoad: {
    type: 'request',
    requestId: 'q3',
    method: 'snapToRoad',
    params: { coordinate: ll, maxDistanceMeters: 30 },
  },
  request_route: { type: 'request', requestId: 'q4', method: 'route', params: { from: ll, to: ll2, modes: ['car'] } },
};

const eventSamples = {
  ready: { type: 'ready', engine: { name: 'maprama-native', version: '0.0.0', kind: 'native' } },
  error: { type: 'error', code: 'unsupported', message: 'not implemented', fatal: false },
  labelsIndex: {
    type: 'labelsIndex',
    labels: [
      { id: 'poi:p1', kind: 'poi', name: 'Cafe', category: 'cafe', subtitle: 'Coffee', lngLat: ll },
      { id: 'road:r1', kind: 'road', name: 'Main', lngLat: ll2 },
    ],
  },
  'map:press': { type: 'map:press', coordinate: ll },
  'building:press': { type: 'building:press', buildingId: 'b1', coordinate: ll },
  'drop:collect': {
    type: 'drop:collect',
    layerId: 'l1',
    dropId: 'd1',
    characterId: 'player',
    coordinate: ll,
    collectId: 'c-1',
  },
  'travel:start': {
    type: 'travel:start',
    requestId: 't1',
    characterId: 'player',
    legs: [
      { mode: 'walk', meters: 120 },
      { mode: 'subway', meters: 2400 },
    ],
  },
  'travel:progress': {
    type: 'travel:progress',
    requestId: 't1',
    characterId: 'player',
    remainingMeters: 800,
    etaSeconds: 60,
    mode: 'subway',
  },
  'travel:arrive': { type: 'travel:arrive', requestId: 't1', characterId: 'player' },
  'travel:cancel': { type: 'travel:cancel', requestId: 't1', characterId: 'player' },
  'geofence:enter': { type: 'geofence:enter', geofenceId: 'g1', characterId: 'player' },
  'geofence:exit': { type: 'geofence:exit', geofenceId: 'g1', characterId: 'player' },
  'character:position': { type: 'character:position', id: 'player', coordinate: ll, headingDeg: 45, speedMps: 1.4 },
  'camera:change': { type: 'camera:change', camera: { center: ll, distance: 100, pitch: 45, bearing: 0 } },
  'overlay:positions': { type: 'overlay:positions', positions: [{ id: 'o1', x: 10, y: 20, visible: true }] },
  response_ok: { type: 'response', requestId: 'q1', ok: true, result: { x: 1, y: 2, visible: true } },
  response_error: { type: 'response', requestId: 'q2', ok: false, error: { code: 'unsupported', message: 'm' } },
};

// ---------------------------------------------------------------------------
// Decode cases
// ---------------------------------------------------------------------------

function decodeCase(decode, name, input) {
  const r = decode(input);
  const c = { name, input, ok: r.ok };
  if (r.ok) {
    c.seq = r.value.seq;
    c.type = r.value.msg.type;
  } else {
    c.error = r.error;
    // JSON.parse error messages are V8-specific; the C++ core only has to match the prefix.
    c.errorPrefixOnly = r.error.startsWith('$: invalid JSON:');
  }
  return c;
}

function envelopeText(kind, msg, seq = 7) {
  return JSON.stringify({ v: 1, seq, kind, msg });
}

/** Envelope-level and parser edge cases shared by commands and events. */
function edgeCases(kind, validMsgText) {
  const other = kind === 'cmd' ? 'evt' : 'cmd';
  const env = (fields) => `{${fields}}`;
  const M = `"msg":${validMsgText}`;
  const nested = (depth) => '['.repeat(depth) + ']'.repeat(depth);
  return [
    ['empty string', ''],
    ['whitespace only', ' \t\r\n'],
    ['not json', 'not json'],
    ['trailing garbage', `${env(`"v":1,"seq":1,"kind":"${kind}",${M}`)} x`],
    ['surrounding json whitespace', ` \n\t\r${env(`"v":1,"seq":1,"kind":"${kind}",${M}`)}\r\n `],
    ['byte order mark', `﻿${env(`"v":1,"seq":1,"kind":"${kind}",${M}`)}`],
    ['vertical tab whitespace', `${env(`"v":1,"seq":1,"kind":"${kind}",${M}`)}`],
    ['array root', '[]'],
    ['null root', 'null'],
    ['string root', '"envelope"'],
    ['number root', '1'],
    ['empty object', '{}'],
    ['v missing', env(`"seq":1,"kind":"${kind}",${M}`)],
    ['v 2', env(`"v":2,"seq":1,"kind":"${kind}",${M}`)],
    ['v string', env(`"v":"1","seq":1,"kind":"${kind}",${M}`)],
    ['v 1.0', env(`"v":1.0,"seq":1,"kind":"${kind}",${M}`)],
    ['v 10e-1', env(`"v":10e-1,"seq":1,"kind":"${kind}",${M}`)],
    ['v 0.1', env(`"v":0.1,"seq":1,"kind":"${kind}",${M}`)],
    ['v 1e21', env(`"v":1e21,"seq":1,"kind":"${kind}",${M}`)],
    ['v 1e-7', env(`"v":1e-7,"seq":1,"kind":"${kind}",${M}`)],
    ['v -0', env(`"v":-0,"seq":1,"kind":"${kind}",${M}`)],
    ['v 5e-324', env(`"v":5e-324,"seq":1,"kind":"${kind}",${M}`)],
    ['v 1e400', env(`"v":1e400,"seq":1,"kind":"${kind}",${M}`)],
    ['v 123456789012345680000', env(`"v":123456789012345680000,"seq":1,"kind":"${kind}",${M}`)],
    ['v object', env(`"v":{"b":[1,"x",null,true],"2":false,"1":{}},"seq":1,"kind":"${kind}",${M}`)],
    ['v escaped string', env(`"v":"a\\"b\\\\c\\u0001\\u001f\\u2028\\ud800\\ud83d\\ude00é\\/","seq":1,"kind":"${kind}",${M}`)],
    ['kind missing', env(`"v":1,"seq":1,${M}`)],
    ['kind other', env(`"v":1,"seq":1,"kind":"${other}",${M}`)],
    ['kind number', env(`"v":1,"seq":1,"kind":3,${M}`)],
    ['seq missing', env(`"v":1,"kind":"${kind}",${M}`)],
    ['seq negative', env(`"v":1,"seq":-1,"kind":"${kind}",${M}`)],
    ['seq fraction', env(`"v":1,"seq":1.5,"kind":"${kind}",${M}`)],
    ['seq string', env(`"v":1,"seq":"1","kind":"${kind}",${M}`)],
    ['seq max safe', env(`"v":1,"seq":9007199254740991,"kind":"${kind}",${M}`)],
    ['seq above max safe', env(`"v":1,"seq":9007199254740992,"kind":"${kind}",${M}`)],
    ['seq 1e400', env(`"v":1,"seq":1e400,"kind":"${kind}",${M}`)],
    ['seq -0', env(`"v":1,"seq":-0,"kind":"${kind}",${M}`)],
    ['seq 2.0', env(`"v":1,"seq":2.0,"kind":"${kind}",${M}`)],
    ['msg missing', env(`"v":1,"seq":1,"kind":"${kind}"`)],
    ['msg null', env(`"v":1,"seq":1,"kind":"${kind}","msg":null`)],
    ['msg array', env(`"v":1,"seq":1,"kind":"${kind}","msg":[]`)],
    ['type missing', env(`"v":1,"seq":1,"kind":"${kind}","msg":{}`)],
    ['type number', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":1}`)],
    ['type unknown', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"bogus"}`)],
    ['type __proto__', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"__proto__"}`)],
    ['type toString', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"toString"}`)],
    ['type constructor', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"constructor"}`)],
    ['type lone surrogate', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"\\ud800x"}`)],
    ['type control char escaped', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"\\u0000\\b\\f\\n\\r\\t"}`)],
    ['raw control char in string', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"a"}`)],
    ['bad escape', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"\\x41"}`)],
    ['bad unicode escape', env(`"v":1,"seq":1,"kind":"${kind}","msg":{"type":"\\u12G4"}`)],
    ['unterminated string', `{"v":1,"seq":1,"kind":"${kind}","msg":{"type":"abc`],
    ['unterminated object', `{"v":1,"seq":1,"kind":"${kind}"`],
    ['trailing comma object', `{"v":1,"seq":1,"kind":"${kind}",${M},}`],
    ['trailing comma array', env(`"v":1,"seq":1,"kind":"${kind}",${M},"x":[1,]`)],
    ['single quotes', `{'v':1}`],
    ['unquoted key', `{v:1}`],
    ['leading zero', env(`"v":01,"seq":1,"kind":"${kind}",${M}`)],
    ['dot without digits', env(`"v":1.,"seq":1,"kind":"${kind}",${M}`)],
    ['leading dot', env(`"v":.5,"seq":1,"kind":"${kind}",${M}`)],
    ['plus sign', env(`"v":+1,"seq":1,"kind":"${kind}",${M}`)],
    ['bare minus', env(`"v":-,"seq":1,"kind":"${kind}",${M}`)],
    ['exponent without digits', env(`"v":1e,"seq":1,"kind":"${kind}",${M}`)],
    ['NaN literal', env(`"v":NaN,"seq":1,"kind":"${kind}",${M}`)],
    ['uppercase literal', env(`"v":1,"seq":1,"kind":"${kind}",${M},"x":TRUE`)],
    ['duplicate key last wins (valid)', env(`"v":2,"seq":1,"kind":"${kind}",${M},"v":1`)],
    ['duplicate key last wins (invalid)', env(`"v":1,"seq":1,"kind":"${kind}",${M},"kind":"${other}"`)],
    ['extra envelope fields', env(`"v":1,"seq":1,"kind":"${kind}",${M},"extra":{"deep":[1,2,3]}`)],
    ['deeply nested extra field (depth 500)', env(`"v":1,"seq":1,"kind":"${kind}",${M},"x":${nested(500)}`)],
    ['unicode everywhere', env(`"v":1,"seq":1,"kind":"${kind}",${M},"한글":"😀\\u00e9"`)],
  ].map(([name, text]) => ({ name, text }));
}

function buildDecodeCases(decode, kind, samples, skip) {
  const cases = [];
  for (const [name, msg] of Object.entries(samples)) {
    const valid = decodeCase(decode, `${name}: valid`, envelopeText(kind, msg));
    if (!valid.ok) throw new Error(`sample ${name} does not decode: ${valid.error}`);
    cases.push(valid);
    for (const m of mutations({ v: 1, seq: 7, kind, msg }, { skip })) {
      cases.push(decodeCase(decode, `${name}: ${m.label}`, m.text));
    }
  }
  const firstMsg = JSON.stringify(Object.values(samples)[0]);
  for (const { name, text } of edgeCases(kind, firstMsg)) cases.push(decodeCase(decode, `edge: ${name}`, text));
  return cases;
}

const nestedPayload = (depth) => {
  let v = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};

const extraCommandCases = [
  ['record integer-like keys are visited first', {
    type: 'setLabelContent',
    entries: { b: { title: 'b' }, 10: { title: 10 }, 2: {}, 4294967295: {}, '01': {} },
  }],
  ['record key needing escapes', { type: 'setLabelContent', entries: { 'a"b\\': { title: 1 } } }],
  ['json payload depth 64', { type: 'setDropLayer', layerId: 'l', drops: [{ id: 'd', type: 'coin', coordinate: ll, payload: nestedPayload(63) }], collectRadiusMeters: 1 }],
  ['json payload depth 65', { type: 'setDropLayer', layerId: 'l', drops: [{ id: 'd', type: 'coin', coordinate: ll, payload: nestedPayload(64) }], collectRadiusMeters: 1 }],
  ['json payload depth 66', { type: 'setDropLayer', layerId: 'l', drops: [{ id: 'd', type: 'coin', coordinate: ll, payload: nestedPayload(66) }], collectRadiusMeters: 1 }],
  ['json payload object keys order', { type: 'setDropLayer', layerId: 'l', drops: [{ id: 'd', type: 'coin', coordinate: ll, payload: { z: 1, 3: { 1: '@@INF@@' }, 1: 2 } }], collectRadiusMeters: 1 }],
  ['model drop without model', { type: 'setDropLayer', layerId: 'l', drops: [{ id: 'd', type: 'model', coordinate: ll }], collectRadiusMeters: 1 }],
  ['request unknown method', { type: 'request', requestId: 'q', method: 'teleport', params: {} }],
  ['request params array', { type: 'request', requestId: 'q', method: 'project', params: [] }],
  ['request route empty modes', { type: 'request', requestId: 'q', method: 'route', params: { from: ll, to: ll, modes: [] } }],
  ['camera animate bad object', { type: 'setCamera', camera: { animate: { durationMs: -1 } } }],
  ['camera pitch 90', { type: 'setCamera', camera: { pitch: 90 } }],
  ['camera pitch 90.0001', { type: 'setCamera', camera: { pitch: 90.0001 } }],
  ['color #RRGGBBAA', { type: 'setBuildingStyle', buildingId: 'b', style: { color: '#11223344' } }],
  ['color #RRGGB', { type: 'setBuildingStyle', buildingId: 'b', style: { color: '#11223' } }],
  ['color with newline', { type: 'setBuildingStyle', buildingId: 'b', style: { color: '#112233\n' } }],
  ['theme base unknown name', { type: 'setTheme', theme: { base: 'neon' } }],
  ['theme base preset missing field', { type: 'setTheme', theme: { base: { ...clone(P.PRESETS.toy), sunMul: undefined } } }],
  ['world procedural seed fraction', { ...commandSamples.init_procedural, world: { kind: 'procedural', layout: 'grid', seed: 1.5 } }],
  ['world unknown kind', { ...commandSamples.init_url, world: { kind: 'tiles' } }],
  ['unicode ids', { type: 'removeCharacters', ids: ['캐릭터', '😀', ''] }],
].map(([name, msg]) => ({
  name: `extra: ${name}`,
  text: envelopeText('cmd', msg).replace('"@@INF@@"', '1e400'),
}));

const commandCases = [
  ...buildDecodeCases(P.decodeCommand, 'cmd', commandSamples, (path) =>
    // World internals are covered exhaustively by world.json; keep this file small.
    path.length > 4 && path[1] === 'world' && path[2] === 'world' && path[3] === 'world',
  ),
  ...extraCommandCases.map(({ name, text }) => decodeCase(P.decodeCommand, name, text)),
];

const eventCases = buildDecodeCases(P.decodeEvent, 'evt', eventSamples);

// ---------------------------------------------------------------------------
// World cases
// ---------------------------------------------------------------------------

/** Twice the signed shoelace area over stored [x, z] (same operation order as the C++ shoelaceArea2). */
function shoelaceArea2(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const t1 = a[0] * b[1];
    const t2 = b[0] * a[1];
    sum += t1 - t2;
  }
  return sum;
}

function worldSummary(w) {
  return {
    name: w.name,
    roads: w.roads.length,
    buildings: w.buildings.length,
    water: w.water.length,
    parks: w.parks.length,
    pois: w.pois.length,
    stations: w.stations.length,
    districts: w.districts.length,
    attribution: w.attribution.length,
    hasPlaza: w.plaza !== undefined,
    negativeAreaFootprints: w.buildings.filter((b) => shoelaceArea2(b.footprint) < 0).length,
  };
}

function worldCase(name, text) {
  const value = JSON.parse(text);
  const r = P.validateWorldData(value);
  return r.ok
    ? { name, input: text, ok: true, summary: worldSummary(value) }
    : { name, input: text, ok: false, error: r.error };
}

const worldCases = [
  worldCase('valid', JSON.stringify(world)),
  worldCase('valid without optional fields', JSON.stringify({ ...world, plaza: undefined, roads: [{ id: 'r', cls: 'alley', pts: [[0, 0], [1, 1]] }] })),
  worldCase('negative winding footprint', JSON.stringify({ ...world, buildings: [{ id: 'cw', footprint: [[0, 0], [1, 1], [1, 0]], height: 1 }] })),
  ...mutations(world).map((m) => worldCase(m.label, m.text)),
];

// Real OSM-derived sample (tools/osm). Read in place by the C++ test; only the expectation is exported.
const seongsuPath = fileURLToPath(new URL('../../../tools/osm/samples/seongsu.world.json', import.meta.url));
if (existsSync(seongsuPath)) {
  const value = JSON.parse(readFileSync(seongsuPath, 'utf8'));
  const r = P.validateWorldData(value);
  worldCases.push(
    r.ok
      ? { name: 'tools/osm/samples/seongsu.world.json', inputPath: seongsuPath, ok: true, summary: worldSummary(value) }
      : { name: 'tools/osm/samples/seongsu.world.json', inputPath: seongsuPath, ok: false, error: r.error },
  );
} else {
  console.warn(`export-fixtures: ${seongsuPath} not found; skipping the real-world sample case`);
}

// ---------------------------------------------------------------------------
// Projection samples
// ---------------------------------------------------------------------------

let rngState = 0x2545f491;
function rand() {
  // xorshift32, deterministic.
  rngState ^= rngState << 13;
  rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0x100000000;
}

const special = (n) => (Number.isFinite(n) ? n : String(n));
const origins = [
  { lng: 126.978, lat: 37.5665 },
  { lng: 0, lat: 0 },
  { lng: -122.4194, lat: 37.7749 },
  { lng: 179.9, lat: -89.99 },
  { lng: -180, lat: 90 },
  { lng: 180, lat: -90 },
  { lng: 151.2093, lat: -33.8688 },
];
const unitMetersList = [undefined, 8, 1, 0.25, 1000];

const projectionSamples = [];
for (const origin of origins) {
  for (const unitMeters of unitMetersList) {
    const proj = P.createProjection(unitMeters === undefined ? { origin } : { origin, unitMeters });
    const toWorld = [];
    const toLngLat = [];
    const distances = [];
    for (let i = 0; i < 24; i++) {
      const input = { lng: origin.lng + (rand() - 0.5) * 0.1, lat: origin.lat + (rand() - 0.5) * 0.1 };
      toWorld.push({ input, expected: proj.toWorld(input) });
      const point = { x: (rand() - 0.5) * 2000, z: (rand() - 0.5) * 2000 };
      toLngLat.push({ input: point, expected: proj.toLngLat(point) });
      const d = rand() * 5000;
      distances.push({ meters: d, units: proj.metersToUnits(d), unitsToMeters: proj.unitsToMeters(d) });
    }
    projectionSamples.push({
      origin,
      ...(unitMeters === undefined ? {} : { unitMeters }),
      expectedUnitMeters: proj.unitMeters,
      toWorld,
      toLngLat,
      distances,
    });
  }
}

function projectionError(options) {
  try {
    P.createProjection(options);
  } catch (e) {
    return e.message;
  }
  throw new Error(`expected createProjection to throw for ${JSON.stringify(options)}`);
}

const projectionErrors = [
  { origin: { lng: 181, lat: 0 } },
  { origin: { lng: 0, lat: -90.5 } },
  { origin: { lng: NaN, lat: 0 } },
  { origin: { lng: 0, lat: Infinity } },
  { origin: { lng: 0, lat: 0 }, unitMeters: 0 },
  { origin: { lng: 0, lat: 0 }, unitMeters: -8 },
  { origin: { lng: 0, lat: 0 }, unitMeters: 0.1e-400 },
  { origin: { lng: 0, lat: 0 }, unitMeters: NaN },
  { origin: { lng: 0, lat: 0 }, unitMeters: Infinity },
  { origin: { lng: 0, lat: 0 }, unitMeters: -1.5e-7 },
  { origin: { lng: 200, lat: 0 }, unitMeters: -1 },
].map((options) => ({
  origin: { lng: special(options.origin.lng), lat: special(options.origin.lat) },
  ...('unitMeters' in options ? { unitMeters: special(options.unitMeters) } : {}),
  error: projectionError(options),
}));

const haversine = [];
for (let i = 0; i < 40; i++) {
  const a = { lng: (rand() - 0.5) * 360, lat: (rand() - 0.5) * 180 };
  const b = i % 2 ? { lng: a.lng + (rand() - 0.5) * 0.02, lat: a.lat + (rand() - 0.5) * 0.02 } : { lng: (rand() - 0.5) * 360, lat: (rand() - 0.5) * 180 };
  haversine.push({ a, b, meters: P.haversineMeters(a, b) });
}

// ---------------------------------------------------------------------------
// JS formatting cases
// ---------------------------------------------------------------------------

const numberTexts = [
  '0', '-0', '1', '-1', '0.1', '0.5', '1e21', '1e+21', '1e-7', '1e-6', '0.000001', '0.0000001', '123456789012345680000',
  '999999999999999999999', '12345678901234567890', '1.7976931348623157e308', '5e-324', '2.5e-324', '1e400', '-1e400',
  '1.5e-10', '100', '1e2', '0.30000000000000004', '-123.456', '9007199254740993', '4.35', '1e300', '123e-20',
  '1.2345678901234567e-7', '98765.4321e3', '0.1e1', '3.14159265358979323846', '1E3', '2e-5', '-5e-7', '1e20', '1.5e20',
  '1234567.125', '255', '16777215', '1.7976931348623157e+308', '0.000123',
];
const jsonTexts = [
  '"plain"',
  '"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t"',
  '"\\u0000\\u0001\\u001f\\u007f\\u0080\\u00e9\\u2028\\u2029\\ufeff"',
  '"\\ud800"',
  '"\\udfff\\ud800x"',
  '"\\ud83d\\ude00😀한글"',
  '[1,"x",null,true,false,[],{}]',
  '{"b":1,"2":2,"1":3,"4294967295":4,"4294967294":5,"01":6,"-1":7,"1.5":8,"a":{"z":[1,{"10":1,"9":2}]}}',
  '{"a":1,"b":2,"a":3}',
  '{"__proto__":1,"constructor":2}',
  '[1e400,-0,0.1]',
];

const jsonFormat = {
  numbers: numberTexts.map((text) => {
    const n = JSON.parse(text);
    return { text, string: String(n), json: JSON.stringify(n) };
  }),
  values: jsonTexts.map((text) => ({ text, json: JSON.stringify(JSON.parse(text)) })),
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const meta = {
  PROTOCOL_VERSION: P.PROTOCOL_VERSION,
  WORLD_DATA_VERSION: P.WORLD_DATA_VERSION,
  DEFAULT_UNIT_METERS: P.DEFAULT_UNIT_METERS,
  METERS_PER_DEGREE_LNG: P.METERS_PER_DEGREE_LNG,
  METERS_PER_DEGREE_LAT: P.METERS_PER_DEGREE_LAT,
  EARTH_RADIUS_METERS: P.EARTH_RADIUS_METERS,
  ENGINE_COMMAND_TYPES: [...P.ENGINE_COMMAND_TYPES],
  ENGINE_EVENT_TYPES: [...P.ENGINE_EVENT_TYPES],
  ENGINE_KINDS: [...P.ENGINE_KINDS],
  REQUEST_METHODS: [...P.REQUEST_METHODS],
  SUBSCRIPTION_TOPICS: [...P.SUBSCRIPTION_TOPICS],
  TRAVEL_MODES: [...P.TRAVEL_MODES],
  LOCATION_SOURCE_KINDS: [...P.LOCATION_SOURCE_KINDS],
  DROP_TYPES: [...P.DROP_TYPES],
  RARITIES: [...P.RARITIES],
  ROOF_SHAPES: [...P.ROOF_SHAPES],
  BUILDING_DECORATIONS: [...P.BUILDING_DECORATIONS],
  ANIMATION_NAMES: [...P.ANIMATION_NAMES],
  ROAD_CLASSES: [...P.ROAD_CLASSES],
  BUILDING_KINDS: [...P.BUILDING_KINDS],
  POI_CATEGORIES: [...P.POI_CATEGORIES],
  PROCEDURAL_LAYOUTS: [...P.PROCEDURAL_LAYOUTS],
  PRESET_NAMES: [...P.PRESET_NAMES],
  TIMES_OF_DAY: [...P.TIMES_OF_DAY],
  SHADING_MODELS: [...P.SHADING_MODELS],
  FACADE_SETS: [...P.FACADE_SETS],
  LANDMARK_GLASS_STYLES: [...P.LANDMARK_GLASS_STYLES],
  MASSING_MODES: [...P.MASSING_MODES],
  ZOOM_OUT_BEHAVIORS: [...P.ZOOM_OUT_BEHAVIORS],
  LABEL_STYLES: [...P.LABEL_STYLES],
  HOLO_ICON_TILES: [...P.HOLO_ICON_TILES],
  LABEL_CONTENT_MODES: [...P.LABEL_CONTENT_MODES],
  LABEL_KINDS: [...P.LABEL_KINDS],
  LABEL_ICONS: [...P.LABEL_ICONS],
};

const files = {
  'protocol-meta.json': meta,
  'decode-command.json': { cases: commandCases },
  'decode-event.json': { cases: eventCases },
  'world.json': { cases: worldCases },
  'projection.json': { samples: projectionSamples, errors: projectionErrors, haversine },
  'json-format.json': jsonFormat,
};

let total = 0;
for (const [file, data] of Object.entries(files)) {
  const text = `${JSON.stringify(data)}\n`;
  writeFileSync(`${outDir}${file}`, text);
  const count = data.cases?.length ?? data.samples?.length ?? Object.keys(data).length;
  total += text.length;
  console.log(`export-fixtures: ${file} (${count} entries, ${(text.length / 1024).toFixed(0)} KiB)`);
}
console.log(`export-fixtures: wrote ${Object.keys(files).length} files (${(total / 1024).toFixed(0)} KiB) to ${outDir}`);
