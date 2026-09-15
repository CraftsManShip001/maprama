#!/usr/bin/env node
/**
 * Game-logic conformance fixtures for the native core (M3 core phase 1), generated from engine-web's real
 * TypeScript sources. engine-web's `dist` is a single bundle that does not export these helpers, so
 * `export-fixtures.mjs` runs this script through tsx:
 *
 *   node --import tsx scripts/export-game-fixtures.mjs <outDir>
 *
 * Files written (the C++ suites in cpp/tests/game_*_tests.cpp compare against them):
 * - travel-plan.json   planLegs / routeResult / snapToRoad on the Seongsu sample (with and without extra
 *                      stations), a small hand-made world and procedural town / grid worlds, plus helper
 *                      samples (playbackSpeeds, etaSeconds, planeAltitude, splitByLength, normalizeModes)
 * - travel-trace.json  TravelManager + Follower traces per fixed dt (timeScale 1 and 20, cancels, re-travel,
 *                      location-driven walks and teleports)
 * - location.json      GpsSmoother sequences, the external LocationService pipeline, demo loops, simulated
 *                      walker traces, locationTrip and drive decisions
 * - drops.json         DropCollector scenarios (setLayer diffs, collection events, per-layer state, history)
 * - geofences.json     GeofenceTracker scenarios (enter / exit, membership kept across setGeofences)
 *
 * Copied engine-web constants (private in features.ts): TELEPORT_UNITS = 40 and the `driveToFix` decision
 * (teleport beyond it, else `locationTrip` → `setTrip([{walk}], speed)`); everything else is engine-web code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '@maprama/protocol';

const outDir = process.argv[2] ?? fileURLToPath(new URL('../cpp/tests/fixtures/', import.meta.url));
const src = (p) => new URL(`../../engine-web/src/${p}`, import.meta.url).href;
const F = await import(src('game/follower.ts'));
const T = await import(src('game/travel.ts'));
const R = await import(src('engine/requests.ts'));
const L = await import(src('game/location.ts'));
const D = await import(src('game/drops.ts'));
const G = await import(src('game/geofences.ts'));
const WD = await import(src('world/data.ts'));
const TW = await import(src('world/town.ts'));
const GW = await import(src('world/grid.ts'));
const M = await import(src('util/math.ts'));

/** features.ts `TELEPORT_UNITS` (module-private). */
const TELEPORT_UNITS = 40;

const pt = (p) => [p.x, p.z];
const ll = (p) => [p.lng, p.lat];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

const seongsuPath = fileURLToPath(new URL('../../../tools/osm/samples/seongsu.world.json', import.meta.url));
const seongsuData = JSON.parse(readFileSync(seongsuPath, 'utf8'));
/** Extra stations so subway legs exist on the real sample (it has a single station). */
const extraStations = [
  { id: 'x:west', name: 'West', x: -40, z: -20 },
  { id: 'x:east', name: 'East', x: 38, z: 30 },
  { id: 'x:north', name: 'North', x: 5, z: -44 },
];
/** The world of engine-web's follower.test.ts. */
const legsData = {
  version: 1,
  name: 'Legs',
  origin: { lng: 127, lat: 37.5 },
  unitMeters: 8,
  bounds: { minX: -60, minZ: -60, maxX: 60, maxZ: 60 },
  roads: [
    { id: 'main', cls: 'arterial', pts: [[-60, 0], [60, 0]] },
    { id: 'cross', cls: 'local', pts: [[0, -60], [0, 60]] },
    { id: 'north', cls: 'local', pts: [[-60, -30], [60, -30]] },
  ],
  buildings: [],
  water: [],
  parks: [],
  pois: [],
  stations: [{ id: 'w', name: 'West', x: -50, z: 2 }, { id: 'e', name: 'East', x: 50, z: -2 }],
  districts: [],
  attribution: [],
};

/** `spec` tells the C++ test how to build the same world. */
const WORLDS = {
  seongsu: { spec: { kind: 'data', inputPath: seongsuPath }, model: WD.loadWorldData(seongsuData) },
  seongsuStations: {
    spec: { kind: 'data', inputPath: seongsuPath, extraStations },
    model: WD.loadWorldData({ ...seongsuData, stations: [...seongsuData.stations, ...extraStations] }),
  },
  legs: { spec: { kind: 'data', data: legsData }, model: WD.loadWorldData(legsData) },
  town42: { spec: { kind: 'procedural', layout: 'town', seed: 42 }, model: TW.buildTownWorld(42) },
  grid7: { spec: { kind: 'procedural', layout: 'grid', seed: 7 }, model: GW.buildGridWorld(7) },
  grid0: { spec: { kind: 'procedural', layout: 'grid', seed: 0 }, model: GW.buildGridWorld(0) },
};
const worldSpecs = Object.fromEntries(Object.entries(WORLDS).map(([k, v]) => [k, v.spec]));
const projOf = (key) => R.projectionFor(WORLDS[key].model);

// ---------------------------------------------------------------------------
// travel-plan.json
// ---------------------------------------------------------------------------

const CHAINS = [
  ['walk'], ['bike'], ['car'], ['plane'], ['subway'],
  ['walk', 'car', 'walk'], ['bike', 'car'], ['walk', 'subway', 'walk'], ['bike', 'subway', 'car'],
  ['walk', 'plane', 'walk'], ['subway', 'plane'], ['plane', 'subway'], ['car', 'walk', 'bike'],
  ['walk', 'walk', 'car', 'car', 'walk'], [], ['walk', 'bike', 'car', 'walk'], ['car', 'subway', 'plane', 'walk'],
  ['subway', 'subway', 'car'], ['car', 'walk'],
];
/** Chains whose `route` results (lng/lat paths) are exported too. */
const ROUTE_CHAINS = 8;

function odPairs(key, seed) {
  const w = WORLDS[key].model;
  const r = M.mulberry32(seed);
  const b = w.bounds;
  const rnd = () => ({ x: b.minX + (b.maxX - b.minX) * r(), z: b.minZ + (b.maxZ - b.minZ) * r() });
  const pairs = [];
  for (let i = 0; i < 6; i++) pairs.push([rnd(), rnd()]);
  const a = rnd();
  pairs.push([a, { ...a }]); // trip to the start point
  pairs.push([a, { x: a.x + 5, z: a.z - 3 }]); // shorter than PLANE_MIN_UNITS
  const n = w.graph.nodes;
  if (n.length > 10) pairs.push([{ x: n[3].x, z: n[3].z }, { x: n[n.length - 5].x, z: n[n.length - 5].z }]); // on nodes
  pairs.push([{ x: b.minX - 30, z: b.minZ - 20 }, { x: b.maxX + 25, z: b.maxZ + 35 }]); // far off the network
  const st = w.stations;
  if (st.length >= 2) {
    pairs.push([{ x: st[0].x + 3, z: st[0].z - 2 }, { x: st[1].x - 2, z: st[1].z + 3 }]); // next to stations
    pairs.push([{ x: st[0].x + 1, z: st[0].z }, { x: st[0].x - 2, z: st[0].z + 1 }]); // both ends share a station
  }
  return pairs;
}

const plans = [];
const routes = [];
const planTimes = {};
for (const [key, seed] of [['seongsu', 11], ['seongsuStations', 12], ['legs', 13], ['town42', 14], ['grid7', 15]]) {
  const w = WORLDS[key].model;
  const proj = projOf(key);
  const t0 = performance.now();
  let count = 0;
  for (const [from, to] of odPairs(key, seed)) {
    CHAINS.forEach((modes, ci) => {
      const legs = F.planLegs(w, from, to, modes);
      count++;
      plans.push({
        world: key,
        from: pt(from),
        to: pt(to),
        modes,
        legs: legs.map((l) => ({ mode: l.mode, pts: l.pts.map(pt), ...(l.stations ? { stations: l.stations.map((s) => s.id) } : {}) })),
      });
      if (ci < ROUTE_CHAINS) {
        const fromLL = proj.toLngLat(from), toLL = proj.toLngLat(to);
        const r = T.routeResult(w, proj, fromLL, toLL, modes);
        routes.push({
          world: key,
          from: ll(fromLL),
          to: ll(toLL),
          modes,
          legs: r.legs.map((l) => ({ mode: l.mode, meters: l.meters, path: l.path.map(ll) })),
          meters: r.meters,
          etaSeconds: r.etaSeconds,
        });
      }
    });
  }
  planTimes[key] = { plans: count, webMs: performance.now() - t0 };
}

const snaps = [];
for (const [key, seed] of [['seongsu', 21], ['legs', 22], ['town42', 23]]) {
  const w = WORLDS[key].model;
  const proj = projOf(key);
  const handlers = R.createRequestHandlers({ world: () => w, view: { worldToScreen: () => ({ x: 0, y: 0, visible: false }), screenToGround: () => null } });
  const r = M.mulberry32(seed);
  const b = w.bounds;
  for (let i = 0; i < 30; i++) {
    const p = { x: b.minX - 20 + (b.maxX - b.minX + 40) * r(), z: b.minZ - 20 + (b.maxZ - b.minZ + 40) * r() };
    const coordinate = proj.toLngLat(p);
    for (const maxDistanceMeters of [undefined, 30, 5]) {
      const params = maxDistanceMeters === undefined ? { coordinate } : { coordinate, maxDistanceMeters };
      const res = handlers.snapToRoad(params);
      snaps.push({
        world: key,
        coordinate: ll(coordinate),
        ...(maxDistanceMeters === undefined ? {} : { maxDistanceMeters }),
        result: res === null ? null : { coordinate: ll(res.coordinate), roadId: res.roadId, distanceMeters: res.distanceMeters },
      });
    }
  }
}

const helpers = {
  playbackSpeeds: [[8, 1], [8, 20], [2, 1], [0.5, 7.5], [1000, 0.001], [8, 3]].map(([unitMeters, timeScale]) => ({
    unitMeters,
    timeScale,
    speeds: P.TRAVEL_MODES.map((m) => F.playbackSpeeds(unitMeters, timeScale)[m]),
  })),
  etaSeconds: [0, 1, 347, 1234.5678, 1e6].flatMap((meters) => P.TRAVEL_MODES.map((mode) => ({ meters, mode, seconds: F.etaSeconds(meters, mode) }))),
  planeAltitude: [-0.5, 0, 0.1, 0.25, 0.5, 0.7, 1, 1.5].flatMap((t) => [0, 5, 20, 53.3, 80, 300].map((length) => ({ t, length, altitude: F.planeAltitude(t, length) }))),
  splitByLength: [
    { pts: [[0, 0], [10, 0], [10, 20]], n: 3 },
    { pts: [[0, 0], [10, 0], [10, 20]], n: 1 },
    { pts: [[0, 0], [0.004, 0], [7, 3], [7, 3], [-2.5, 11.25], [30, 11]], n: 4 },
    { pts: [[1, 1], [1, 1]], n: 3 },
    { pts: [[0, 0], [3, 4]], n: 7 },
    { pts: [[-5.5, 2.25], [13.1, -7.7], [13.1, 30.3], [0, 0.001]], n: 2 },
  ].map(({ pts, n }) => ({ pts, n, parts: F.splitByLength(pts.map(([x, z]) => ({ x, z })), n).map((p) => p.map(pt)) })),
  normalizeModes: [[], ['walk'], ['walk', 'walk', 'car', 'car', 'walk'], ['plane', 'plane'], ['subway', 'walk', 'subway']].map((modes) => ({ modes, normalized: F.normalizeModes(modes) })),
  remainingEta: [
    { rem: [{ mode: 'walk', d: 10 }, { mode: 'car', d: 100 }], unitMeters: 8, timeScale: 1 },
    { rem: [{ mode: 'walk', d: 10 }, { mode: 'car', d: 100 }], unitMeters: 8, timeScale: 20 },
    { rem: [{ mode: 'subway', d: 33.3 }, { mode: 'plane', d: 0.1 }, { mode: 'bike', d: 7 }], unitMeters: 2.5, timeScale: 3 },
    { rem: [], unitMeters: 8, timeScale: 20 },
  ].map((c) => ({ ...c, seconds: F.remainingEtaSeconds(c.rem, c.unitMeters, c.timeScale) })),
  groundY: { grid: F.groundYFor('grid'), town: F.groundYFor('town'), data: F.groundYFor('data') },
};

// ---------------------------------------------------------------------------
// travel-trace.json
// ---------------------------------------------------------------------------

class Body {
  x = 0; y = 0; z = 0; speed = 0; targetYaw = 0; planePitch = 0; mode = 'walk';
  setMode(m) {
    if (m === this.mode) return false;
    this.mode = m;
    return true;
  }
}

function runTrace(sc) {
  const w = WORLDS[sc.world].model;
  const proj = projOf(sc.world);
  const gy = F.groundYFor(w.kind);
  let events = [];
  const chars = new Map();
  const travel = new T.TravelManager({
    world: () => w,
    projection: () => proj,
    materials: null,
    emit: (e) => events.push(e),
    overlayParent: { add() {}, remove() {} },
    groundY: () => gy,
  });
  const allWants = { active: true, wants: () => true, due: () => true };
  for (const c of sc.characters) {
    const ch = new Body();
    ch.id = c.id;
    ch.spec = { isPlayer: false };
    ch.x = c.x;
    ch.z = c.z;
    ch.y = gy;
    ch.follower = new F.Follower(ch, gy);
    chars.set(c.id, ch);
  }
  const commands = sc.commands.map((c) => {
    if (c.type !== 'travel') return c;
    const to = proj.toLngLat({ x: c.to[0], z: c.to[1] });
    return { ...c, toLngLat: ll(to), toWorld: pt(proj.toWorld(to)) };
  });
  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i <= sc.steps; i++) {
    for (const c of commands.filter((cmd) => cmd.at === i)) {
      const ch = chars.get(c.characterId);
      if (c.type === 'travel') travel.start(c.requestId, ch, { lng: c.toLngLat[0], lat: c.toLngLat[1] }, c.modes, c.timeScale);
      else if (c.type === 'cancel') travel.cancel(c.characterId);
      else if (c.type === 'drive') {
        // features.ts `driveToFix`
        if (travel.isTraveling(ch.id)) continue;
        const fix = { x: c.estimate[0], z: c.estimate[1] };
        if (Math.hypot(fix.x - ch.x, fix.z - ch.z) > TELEPORT_UNITS) {
          ch.follower.setTrip([]);
          ch.x = fix.x;
          ch.z = fix.z;
          continue;
        }
        const trip = L.locationTrip(w.graph, { x: ch.x, z: ch.z }, fix);
        ch.follower.onArrive = null;
        ch.follower.setTrip(trip.pts.length > 1 ? [{ mode: 'walk', pts: trip.pts }] : [], trip.speed);
      }
    }
    if (i > 0) {
      // CharacterManager.step
      for (const ch of chars.values()) {
        ch.follower.step(sc.dt);
        if (!ch.follower.active && ch.mode !== 'walk' && ch.follower.wait <= 0) ch.setMode('walk');
      }
    }
    if (events.length || i % sc.every === 0 || i === sc.steps) {
      const progress = [];
      const keep = events;
      events = progress;
      travel.progress(allWants, 0);
      events = [];
      samples.push({
        i,
        events: keep.map(eventJson),
        progress: progress.map(eventJson),
        chars: [...chars.values()].map((ch) => ({
          id: ch.id, x: ch.x, y: ch.y, z: ch.z, speed: ch.speed, targetYaw: ch.targetYaw, planePitch: ch.planePitch,
          mode: ch.mode, li: ch.follower.li, si: ch.follower.si, wait: ch.follower.wait, active: ch.follower.active,
          followerMode: ch.follower.mode,
        })),
      });
    }
  }
  return { ...sc, commands, webMs: performance.now() - t0, samples };
}

function eventJson(e) {
  switch (e.type) {
    case 'travel:start':
      return { type: e.type, requestId: e.requestId, characterId: e.characterId, legs: e.legs.map((l) => ({ mode: l.mode, meters: l.meters })) };
    case 'travel:progress':
      return { type: e.type, requestId: e.requestId, characterId: e.characterId, remainingMeters: e.remainingMeters, etaSeconds: e.etaSeconds, mode: e.mode };
    default:
      return { type: e.type, requestId: e.requestId, characterId: e.characterId };
  }
}

const node = (key, k) => { const n = WORLDS[key].model.graph.nodes; const p = n[((k % n.length) + n.length) % n.length]; return [p.x, p.z]; };
const stationAt = (key, k, dx = 0, dz = 0) => { const s = WORLDS[key].model.stations[k]; return [s.x + dx, s.z + dz]; };
const townStart = WORLDS.town42.model.start;

const TRACES = [
  // Endpoints on the connected part of the real Seongsu network (≈ 89 units = 711 m of walking ≈ 533 s).
  { name: 'seongsu walk, timeScale 1', world: 'seongsu', dt: 0.1, steps: 5600, every: 50,
    characters: [{ id: 'p', x: 8.2, z: -36 }],
    commands: [{ at: 0, type: 'travel', requestId: 't1', characterId: 'p', to: [9.6, 7.4], modes: ['walk'], timeScale: 1 }] },
  { name: 'seongsu walk-car-walk, timeScale 20', world: 'seongsu', dt: 1 / 30, steps: 900, every: 6,
    characters: [{ id: 'p', x: 34.8, z: 3.7 }],
    commands: [{ at: 0, type: 'travel', requestId: 't2', characterId: 'p', to: [-41.7, 2.95], modes: ['walk', 'car', 'walk'], timeScale: 20 }] },
  { name: 'seongsu subway (extra stations), timeScale 20', world: 'seongsuStations', dt: 0.05, steps: 1200, every: 8,
    characters: [{ id: 'p', x: -44, z: -12 }],
    commands: [{ at: 0, type: 'travel', requestId: 't3', characterId: 'p', to: [36, 35], modes: ['subway'], timeScale: 20 }] },
  { name: 'town plane, timeScale 1', world: 'town42', dt: 0.05, steps: 700, every: 5,
    characters: [{ id: 'p', x: townStart.x, z: townStart.z }],
    commands: [{ at: 0, type: 'travel', requestId: 't4', characterId: 'p', to: [70, 60], modes: ['walk', 'plane', 'walk'], timeScale: 1 }] },
  { name: 'town bike-subway-car, timeScale 20, dt 0.25', world: 'town42', dt: 0.25, steps: 400, every: 2,
    characters: [{ id: 'p', x: stationAt('town42', 2, 6, -4)[0], z: stationAt('town42', 2, 6, -4)[1] }],
    commands: [{ at: 0, type: 'travel', requestId: 't5', characterId: 'p', to: stationAt('town42', 3, -5, 7), modes: ['bike', 'subway', 'car'], timeScale: 20 }] },
  { name: 'grid car, cancel and re-travel, dt 0.5', world: 'grid7', dt: 0.5, steps: 200, every: 1,
    characters: [{ id: 'p', x: -38, z: -35 }],
    commands: [
      { at: 0, type: 'travel', requestId: 't6', characterId: 'p', to: [38, 37], modes: ['car'], timeScale: 20 },
      { at: 10, type: 'cancel', characterId: 'p' },
      { at: 15, type: 'travel', requestId: 't7', characterId: 'p', to: [-20, 30], modes: ['walk'], timeScale: 20 },
      { at: 40, type: 'travel', requestId: 't8', characterId: 'p', to: [30, -30], modes: ['bike', 'car'], timeScale: 20 },
      { at: 45, type: 'cancel', characterId: 'p' },
      { at: 46, type: 'cancel', characterId: 'p' },
    ] },
  { name: 'legs world: no-leg trip, re-travel while travelling', world: 'legs', dt: 0.1, steps: 400, every: 4,
    characters: [{ id: 'p', x: 3, z: 0 }, { id: 'q', x: -40, z: 3 }],
    commands: [
      { at: 0, type: 'travel', requestId: 'same', characterId: 'p', to: [3, 0], modes: ['car'], timeScale: 20 },
      { at: 0, type: 'travel', requestId: 'q1', characterId: 'q', to: [2, 40], modes: ['walk', 'car', 'walk'], timeScale: 20 },
      { at: 2, type: 'travel', requestId: 'p1', characterId: 'p', to: [-45, 10], modes: ['plane'], timeScale: 20 },
      { at: 30, type: 'travel', requestId: 'q2', characterId: 'q', to: [44, -12], modes: ['subway'], timeScale: 20 },
    ] },
  { name: 'town location drive: walks, speed 0, off-road, teleport', world: 'town42', dt: 0.05, steps: 900, every: 10,
    characters: [{ id: 'p', x: townStart.x, z: townStart.z }],
    commands: [
      { at: 0, type: 'drive', characterId: 'p', estimate: [townStart.x + 6, townStart.z + 1.5] },
      { at: 60, type: 'drive', characterId: 'p', estimate: [townStart.x + 6.1, townStart.z + 1.5] },
      { at: 120, type: 'drive', characterId: 'p', estimate: [townStart.x + 14, townStart.z - 9] },
      { at: 200, type: 'drive', characterId: 'p', estimate: [townStart.x + 20, townStart.z + 25] },
      { at: 330, type: 'drive', characterId: 'p', estimate: [townStart.x + 70, townStart.z + 40] },
      { at: 400, type: 'drive', characterId: 'p', estimate: [townStart.x + 72, townStart.z + 40.2] },
      { at: 500, type: 'travel', requestId: 'lt', characterId: 'p', to: [townStart.x + 40, townStart.z + 40], modes: ['walk'], timeScale: 20 },
      { at: 520, type: 'drive', characterId: 'p', estimate: [townStart.x + 30, townStart.z + 30] },
      { at: 700, type: 'drive', characterId: 'p', estimate: [townStart.x + 10, townStart.z + 3] },
    ] },
  { name: 'town two characters, timeScale 20', world: 'town42', dt: 1 / 60, steps: 1500, every: 15,
    characters: [{ id: 'a', x: -30, z: -19 }, { id: 'b', x: 42, z: 30 }],
    commands: [
      { at: 0, type: 'travel', requestId: 'ra', characterId: 'a', to: [60, -40], modes: ['car'], timeScale: 20 },
      { at: 5, type: 'travel', requestId: 'rb', characterId: 'b', to: [-60, 50], modes: ['bike', 'walk'], timeScale: 20 },
      { at: 300, type: 'travel', requestId: 'ra2', characterId: 'a', to: [-80, 70], modes: ['plane', 'walk'], timeScale: 20 },
    ] },
  { name: 'grid plane at timeScale 20 then back to walking', world: 'grid0', dt: 1 / 60, steps: 600, every: 3,
    characters: [{ id: 'p', x: -35, z: -35 }],
    commands: [{ at: 0, type: 'travel', requestId: 'pl', characterId: 'p', to: [35, 33], modes: ['plane'], timeScale: 20 }] },
];
const traces = TRACES.map(runTrace);

// ---------------------------------------------------------------------------
// location.json
// ---------------------------------------------------------------------------

function smootherCase(name, options, fixes) {
  const s = new L.GpsSmoother(options);
  return { name, options, fixes, out: fixes.map((f) => ({ ...s.push(f) })) };
}

function noisyWalk(seed, n, vx, vz, sd, extra = () => ({})) {
  const r = M.mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: i * vx + L.gauss(r) * sd, z: i * vz + L.gauss(r) * sd, t: i, ...extra(i, r) });
  return out;
}

const still = (n, t0 = 0) => Array.from({ length: n }, (_, i) => ({ x: 0, z: 0, t: t0 + i }));
const smoother = [
  smootherCase('first fix', undefined, [{ x: 3, z: 4, t: 0 }]),
  smootherCase('straight noisy walk', undefined, noisyWalk(5, 80, 1.2, 0.3, 0.8)),
  smootherCase('single outlier', undefined, [...still(5), { x: 40, z: 0, t: 5 }, { x: 0.2, z: 0, t: 6 }, { x: 0.3, z: 0.1, t: 7 }]),
  smootherCase('three outliers jump', { maxConsecutiveRejects: 3 }, [...still(5), { x: 60, z: 0, t: 5 }, { x: 60, z: 0, t: 6 }, { x: 60, z: 0, t: 7 }, { x: 61, z: 0.5, t: 8 }, { x: 62, z: 1, t: 9 }]),
  smootherCase('two outliers then normal', undefined, [...still(4), { x: 30, z: 5, t: 4 }, { x: -30, z: 5, t: 5 }, { x: 0.1, z: 0, t: 6 }, { x: 30, z: 5, t: 7 }, { x: 0, z: 0.2, t: 8 }]),
  smootherCase('poor accuracy (max 10)', { maxAccuracyUnits: 10 }, [{ x: 0, z: 0, t: 0 }, { x: 1, z: 0, t: 1, accuracy: 25 }, { x: 1, z: 0, t: 2, accuracy: 2 }, { x: 2, z: 0, t: 3, accuracy: 10 }, { x: 3, z: 0, t: 4, accuracy: 10.5 }]),
  smootherCase('poor accuracy three times (default)', undefined, [...still(3).map((f) => ({ ...f, accuracy: 3 })), { x: 2, z: 1, t: 3, accuracy: 30 }, { x: 2, z: 1, t: 4, accuracy: 40 }, { x: 2, z: 1, t: 5, accuracy: 35 }, { x: 2.2, z: 1, t: 6, accuracy: 4 }]),
  smootherCase('jump without accuracy uses inn / 2', { maxConsecutiveRejects: 2 }, [...still(3), { x: 25, z: 25, t: 3 }, { x: 25, z: 25, t: 4 }, { x: 26, z: 25, t: 5 }]),
  smootherCase('timestamps clamp', undefined, [{ x: 0, z: 0, t: 10 }, { x: 0.5, z: 0, t: 10 }, { x: 1, z: 0, t: 10.01 }, { x: 1.5, z: 0, t: 30 }, { x: 2, z: 0, t: 29 }, { x: 2.5, z: 0.5, t: 29.5 }]),
  smootherCase('fast turn with velocity clamp', undefined, [
    ...Array.from({ length: 8 }, (_, i) => ({ x: i * 6, z: 0, t: i })),
    ...Array.from({ length: 8 }, (_, i) => ({ x: 42, z: (i + 1) * 6, t: 8 + i })),
  ]),
  smootherCase('custom gains', { gain: 0.5, velocityGain: 0.5, outlierUnits: 2, maxSpeedUnits: 3 }, noisyWalk(8, 40, 0.9, -0.6, 1.1)),
  smootherCase('noisy with random outliers and accuracy', undefined, noisyWalk(13, 120, 0.8, 0.8, 0.9, (i, r) => (i % 7 === 3 ? { x: i * 0.8 + 18 * (r() - 0.5), accuracy: 2 + 20 * r() } : { accuracy: 1 + 4 * r() }))),
];

function locationPipeline(key, seed) {
  const w = WORLDS[key].model;
  const proj = projOf(key);
  const outs = [];
  const svc = new L.LocationService({ world: () => w, toWorld: (p) => proj.toWorld(p), onFix: (f) => outs.push(f), onError: () => {}, now: () => 0, rng: M.mulberry32(seed) });
  svc.worldChanged(w);
  const r = M.mulberry32(seed + 1);
  const steps = [];
  const base = proj.toLngLat(w.start);
  for (let i = 0; i < 60; i++) {
    if (i === 0) steps.push({ setKind: 'external', changed: true });
    if (i === 40) steps.push({ setKind: 'simulated', changed: true });
    if (i === 45) steps.push({ setKind: 'external', changed: true });
    if (i === 40 || i === 45) svc.setKind(i === 40 ? 'simulated' : 'external');
    if (i === 0) svc.setKind('external');
    const fix = { lng: base.lng + i * 1.1e-5 + (r() - 0.5) * 2e-5, lat: base.lat - i * 0.4e-5 + (r() - 0.5) * 2e-5, timestamp: 1700000000000 + i * 1000 + Math.floor(r() * 50) };
    if (i % 3 !== 1) fix.accuracyMeters = 3 + r() * (i % 11 === 5 ? 200 : 20);
    if (i % 4 === 0) fix.headingDeg = r() * 360;
    if (i === 20) fix.lng += 0.004; // jump
    const before = outs.length;
    const used = svc.push(fix);
    const o = outs.length > before ? outs[outs.length - 1] : null;
    steps.push({ fix, used, ...(o ? { out: { x: o.x, z: o.z, accuracy: o.accuracy, rejected: o.rejected, vx: o.vx, vz: o.vz, raw: pt(o.raw), ...(o.headingDeg !== undefined ? { headingDeg: o.headingDeg } : {}) } } : {}) });
  }
  return { world: key, seed, steps };
}

function simulated(key, seed, steps) {
  const w = WORLDS[key].model;
  const loop = L.buildDemoLoop(w);
  const walker = new L.SimulatedWalker(loop, M.mulberry32(seed));
  const s = new L.GpsSmoother();
  const fixes = [];
  const truth = [];
  let t = 0;
  for (let i = 0; i < steps; i++) {
    t += 0.05;
    const f = walker.step(0.05);
    if (i % 10 === 0) truth.push({ i, x: walker.truth.x, z: walker.truth.z, seg: walker.seg, t: walker.t });
    if (!f) continue;
    const o = s.push({ x: f.x, z: f.z, t });
    fixes.push({ i, x: f.x, z: f.z, outlier: f.outlier, out: { ...o } });
  }
  return { world: key, seed, steps, dt: 0.05, loop: loop.map(pt), fixes, truth };
}

const demoLoops = ['grid0', 'town42', 'seongsu', 'legs'].map((key) => ({ world: key, loop: L.buildDemoLoop(WORLDS[key].model).map(pt), start: pt(WORLDS[key].model.start) }));

function tripCases(key, seed) {
  const w = WORLDS[key].model;
  const r = M.mulberry32(seed);
  const n = w.graph.nodes;
  const out = [];
  for (let i = 0; i < 40; i++) {
    const a = n[Math.floor(r() * n.length)], b = n[Math.floor(r() * n.length)];
    const from = { x: a.x + (r() - 0.5) * (i % 5 === 0 ? 0.08 : 3), z: a.z + (r() - 0.5) * 3 };
    const near = i % 4;
    const est = near === 0 ? { x: from.x + (r() - 0.5) * 0.3, z: from.z + (r() - 0.5) * 0.3 }
      : near === 1 ? { x: b.x + (r() - 0.5) * 12, z: b.z + (r() - 0.5) * 12 }
        : { x: a.x + (r() - 0.5) * 30, z: a.z + (r() - 0.5) * 30 };
    const trip = L.locationTrip(w.graph, from, est);
    const maxSnap = i % 6 === 0 ? 1.5 : undefined;
    const trip2 = maxSnap === undefined ? null : L.locationTrip(w.graph, from, est, maxSnap);
    let drive;
    if (Math.hypot(est.x - from.x, est.z - from.z) > TELEPORT_UNITS) drive = { teleport: true };
    else drive = { teleport: false };
    out.push({ world: key, from: pt(from), est: pt(est), pts: trip.pts.map(pt), speed: trip.speed, ...(trip2 ? { maxSnap, pts2: trip2.pts.map(pt), speed2: trip2.speed } : {}), drive });
  }
  return out;
}

const gaussSamples = (() => {
  const r = M.mulberry32(9);
  return Array.from({ length: 24 }, () => L.gauss(r));
})();

const location = {
  constants: { SIMULATED_WALK_SPEED: L.SIMULATED_WALK_SPEED, MAX_SNAP_UNITS: L.MAX_SNAP_UNITS, TELEPORT_UNITS },
  smoother,
  pipelines: [locationPipeline('seongsu', 31), locationPipeline('town42', 32)],
  demoLoops,
  simulated: [simulated('grid0', 42, 3000), simulated('town42', 7, 2400), simulated('seongsu', 3, 2400)],
  trips: [...tripCases('seongsu', 41), ...tripCases('town42', 42), ...tripCases('legs', 43)],
  gauss: { seed: 9, values: gaussSamples },
};

// ---------------------------------------------------------------------------
// drops.json
// ---------------------------------------------------------------------------

const DROP_PROJ = P.createProjection({ origin: { lng: 127, lat: 37.5 }, unitMeters: 8 });

/** Drop spec at a world point (coordinate through the projection, like a host would send it). */
const dspec = (id, x, z, extra = {}) => ({ id, type: 'coin', coordinate: DROP_PROJ.toLngLat({ x, z }), ...extra });

function idGenerator(gen) {
  if (gen.kind === 'counter') {
    let n = 0;
    return () => `${gen.prefix}${++n}`;
  }
  let n = 0;
  return () => gen.values[Math.min(n++, gen.values.length - 1)];
}

function runDrops(sc) {
  const c = new D.DropCollector(idGenerator(sc.ids));
  const results = [];
  const t0 = performance.now();
  for (const op of sc.ops) {
    const res = { op: op.op };
    if (op.op === 'setLayer') {
      // Features.applyDropLayer
      const drops = op.drops.map((spec) => ({ spec, ...DROP_PROJ.toWorld(spec.coordinate) }));
      op.world = drops.map((d) => [d.x, d.z]);
      const diff = c.setLayer(op.layerId, drops, op.collectRadiusMeters / 8, op.collectorIds);
      res.diff = { added: diff.added.map((d) => d.spec.id), removed: diff.removed.map((d) => d.spec.id), moved: diff.moved.map((d) => d.spec.id) };
    } else if (op.op === 'removeLayer') {
      res.removed = c.removeLayer(op.layerId).map((d) => d.spec.id);
    } else {
      try {
        res.events = c.check(op.collectors, (p) => DROP_PROJ.toLngLat(p)).map(({ event: e }) => ({ layerId: e.layerId, dropId: e.dropId, characterId: e.characterId, coordinate: ll(e.coordinate), collectId: e.collectId }));
      } catch (e) {
        res.error = e.message;
      }
    }
    // Per-layer state after every op (every 10th check of long scenarios, to keep the fixture small).
    if (sc.ops.length < 100 || op.op !== 'check' || results.length % 10 === 0) res.state = {
      layers: c.layerIds().map((id) => ({ id, drops: c.drops(id).map((d) => ({ id: d.spec.id, x: d.x, z: d.z, collected: d.collected, type: d.spec.type })) })),
      history: [...c.history].sort(),
    };
    results.push(res);
  }
  return { name: sc.name, unitMeters: 8, origin: { lng: 127, lat: 37.5 }, ids: sc.ids, ops: sc.ops, results, webMs: performance.now() - t0 };
}

const me = (x, z) => ({ id: 'me', x, z, isPlayer: true });
const npc = (x, z, id = 'npc') => ({ id, x, z, isPlayer: false });

function passThroughOps() {
  const ops = [
    { op: 'setLayer', layerId: 'coins', drops: Array.from({ length: 8 }, (_, i) => dspec(`c${i}`, i * 3, i % 2 ? 0.8 : -0.6, { value: 10 * (i + 1) })), collectRadiusMeters: 12 },
    { op: 'setLayer', layerId: 'gems', drops: [
      dspec('g-common', 4, 0, { type: 'note' }), dspec('g-rare', 4.2, 0.3, { type: 'cd', rarity: 'rare' }),
      dspec('g-legendary', 4.4, -0.2, { type: 'vinyl', rarity: 'legendary' }), dspec('g-model', 13, 0, { type: 'model', model: { uri: 'asset://gem.glb' }, rarity: 'rare' }),
    ], collectRadiusMeters: 10 },
  ];
  for (let x = -3; x <= 26; x += 0.5) ops.push({ op: 'check', collectors: [me(x, 0.1)] });
  return ops;
}

function randomOps(seed) {
  const r = M.mulberry32(seed);
  const drops = Array.from({ length: 200 }, (_, i) => dspec(`r${i}`, (r() - 0.5) * 80, (r() - 0.5) * 80, { rarity: ['common', 'rare', 'legendary'][i % 3] }));
  const ops = [
    { op: 'setLayer', layerId: 'field', drops, collectRadiusMeters: 16 },
    { op: 'setLayer', layerId: 'npcs', drops: drops.slice(0, 60).map((d) => ({ ...d, id: `n-${d.id}` })), collectRadiusMeters: 24, collectorIds: ['npc1', 'npc2'] },
  ];
  const pos = [[0, 0], [10, 10], [-10, 5]];
  for (let f = 0; f < 120; f++) {
    for (const p of pos) { p[0] += (r() - 0.5) * 3; p[1] += (r() - 0.5) * 3; }
    ops.push({ op: 'check', collectors: [npc(pos[1][0], pos[1][1], 'npc1'), me(pos[0][0], pos[0][1]), npc(pos[2][0], pos[2][1], 'npc2')] });
    if (f === 60) ops.push({ op: 'setLayer', layerId: 'field', drops: drops.filter((_, i) => i % 5 !== 0), collectRadiusMeters: 16 });
    if (f === 80) ops.push({ op: 'setLayer', layerId: 'field', drops, collectRadiusMeters: 20 });
  }
  return ops;
}

const DROP_SCENARIOS = [
  { name: 'multi-drop pass-through', ids: { kind: 'counter', prefix: 'cid-' }, ops: passThroughOps() },
  { name: 'collectors', ids: { kind: 'counter', prefix: 'k' }, ops: [
    { op: 'setLayer', layerId: 'default', drops: [dspec('d', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [npc(0, 0)] },
    { op: 'check', collectors: [npc(0, 0), me(0, 0)] },
    { op: 'setLayer', layerId: 'npcOnly', drops: [dspec('n', 0, 0)], collectRadiusMeters: 8, collectorIds: ['npc'] },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'check', collectors: [me(0, 0), npc(0, 0)] },
    { op: 'setLayer', layerId: 'nobody', drops: [dspec('x', 0, 0)], collectRadiusMeters: 8, collectorIds: [] },
    { op: 'setLayer', layerId: 'both', drops: [dspec('b1', 0, 0), dspec('b2', 0.5, 0)], collectRadiusMeters: 8, collectorIds: ['me', 'npc', 'ghost'] },
    { op: 'check', collectors: [npc(0.2, 0), me(0, 0)] },
    { op: 'check', collectors: [me(0, 0), npc(0.2, 0)] },
    { op: 'check', collectors: [me(0, 0), npc(0.2, 0)] },
  ] },
  { name: 'retryable and final rejections', ids: { kind: 'counter', prefix: 'v' }, ops: [
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 0, 0), dspec('b', 5, 5)], collectRadiusMeters: 8, collectorIds: ['me', 'npc'] },
    { op: 'check', collectors: [me(0, 0)] },
    // RN DropLayer hides the collected drop while the service verifies it …
    { op: 'setLayer', layerId: 'l', drops: [dspec('b', 5, 5)], collectRadiusMeters: 8, collectorIds: ['me', 'npc'] },
    { op: 'check', collectors: [me(0, 0)] },
    // … and restores it after a retryable rejection (TOO_FAR, NETWORK_ERROR, …): collectable again
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 0, 0), dspec('b', 5, 5)], collectRadiusMeters: 8, collectorIds: ['me', 'npc'] },
    { op: 'check', collectors: [me(0, 0)] },
    // final rejection (ALREADY_COLLECTED, …): stays hidden
    { op: 'setLayer', layerId: 'l', drops: [dspec('b', 5, 5)], collectRadiusMeters: 8, collectorIds: ['me', 'npc'] },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'check', collectors: [me(5, 5)] },
    // a host that keeps sending a collected id: the same collector cannot collect it again, another can
    { op: 'setLayer', layerId: 'l', drops: [dspec('b', 5, 5)], collectRadiusMeters: 8, collectorIds: ['me', 'npc'] },
    { op: 'check', collectors: [me(5, 5)] },
    { op: 'setLayer', layerId: 'l', drops: [dspec('b', 6, 5)], collectRadiusMeters: 8, collectorIds: ['me', 'npc'] },
    { op: 'check', collectors: [me(5, 5)] },
    { op: 'check', collectors: [me(5, 5), npc(5, 5)] },
  ] },
  { name: 'look changes, moves and diffs', ids: { kind: 'counter', prefix: 'd' }, ops: [
    { op: 'setLayer', layerId: 'l', drops: [dspec('keep', 0, 0), dspec('gone', 5, 5), dspec('swap', 9, 9), dspec('rar', 20, 0), dspec('mod', 30, 0, { type: 'model', model: { uri: 'a.glb' } }), dspec('val', 40, 0, { value: 5 })], collectRadiusMeters: 4 },
    { op: 'setLayer', layerId: 'l', drops: [dspec('keep', 1, 0), dspec('swap', 9, 9, { type: 'cd' }), dspec('new', 3, 3), dspec('rar', 20, 0, { rarity: 'common' }), dspec('mod', 30, 0, { type: 'model', model: { uri: 'b.glb' } }), dspec('val', 40, 0, { value: 6 })], collectRadiusMeters: 4 },
    { op: 'setLayer', layerId: 'l', drops: [dspec('keep', 1, 0), dspec('swap', 9, 9, { type: 'cd' }), dspec('rar', 20, 0, { rarity: 'rare' }), dspec('val', 40.5, 0, { value: 6 })], collectRadiusMeters: 4 },
    { op: 'check', collectors: [me(1, 0.2)] },
    // a collected drop re-sent with a new look is shown again but stays uncollectable for the collector
    { op: 'setLayer', layerId: 'l', drops: [dspec('keep', 1, 0, { type: 'note' }), dspec('swap', 9, 9, { type: 'cd' })], collectRadiusMeters: 4 },
    { op: 'check', collectors: [me(1, 0.2)] },
    { op: 'removeLayer', layerId: 'l' },
    { op: 'removeLayer', layerId: 'l' },
    { op: 'check', collectors: [me(1, 0.2)] },
  ] },
  { name: 'removeLayer forgets, layer order', ids: { kind: 'counter', prefix: 'o' }, ops: [
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 0, 0)], collectRadiusMeters: 8 },
    { op: 'setLayer', layerId: 'm', drops: [dspec('a', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'removeLayer', layerId: 'l' },
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 0, 0)], collectRadiusMeters: 8 },
    { op: 'setLayer', layerId: 'm', drops: [dspec('a', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'setLayer', layerId: 'k', drops: [dspec('z', 0, 0), dspec('y', 0, 0)], collectRadiusMeters: 8 },
    { op: 'setLayer', layerId: 'm', drops: [dspec('b', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
  ] },
  { name: 'duplicate ids in one spec', ids: { kind: 'counter', prefix: 'u' }, ops: [
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 0, 0), dspec('b', 10, 0), dspec('a', 2, 0)], collectRadiusMeters: 8 },
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 1, 0), dspec('a', 1, 0, { type: 'cd' }), dspec('b', 10, 0), dspec('a', 3, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(3, 0)] },
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 3, 0), dspec('a', 3, 0, { type: 'cd' })], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(3, 0)] },
  ] },
  { name: 'NUL-separated history keys', ids: { kind: 'counter', prefix: 'n' }, ops: [
    { op: 'setLayer', layerId: 'a\u0000b', drops: [dspec('c', 0, 0)], collectRadiusMeters: 8 },
    { op: 'setLayer', layerId: 'a', drops: [dspec('b\u0000c', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'setLayer', layerId: 'a', drops: [], collectRadiusMeters: 8 },
    { op: 'setLayer', layerId: 'a', drops: [dspec('b\u0000c', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'removeLayer', layerId: 'a' },
    { op: 'setLayer', layerId: 'a\u0000b', drops: [dspec('c', 0, 0), dspec('d', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'setLayer', layerId: '한글 레이어', drops: [dspec('😀', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0), { id: '캐릭터', x: 0, z: 0, isPlayer: true }] },
  ] },
  { name: 'collectId generator repeats', ids: { kind: 'sequence', values: ['x', 'x', '', 'y', 'y', 'y', 'y', 'y', 'y', 'y', 'y', 'y', 'z'] }, ops: [
    { op: 'setLayer', layerId: 'l', drops: [dspec('a', 0, 0), dspec('b', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'setLayer', layerId: 'm', drops: [dspec('p', 0, 0), dspec('q', 0, 0)], collectRadiusMeters: 8 },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'check', collectors: [me(0, 0)] },
  ] },
  { name: 'radius edges', ids: { kind: 'counter', prefix: 'e' }, ops: [
    { op: 'setLayer', layerId: 'zero', drops: [dspec('z', 0, 0)], collectRadiusMeters: 0 },
    { op: 'setLayer', layerId: 'neg', drops: [dspec('n', 0, 0)], collectRadiusMeters: -5 },
    { op: 'setLayer', layerId: 'exact', drops: [dspec('x', 10, 0)], collectRadiusMeters: 16 },
    { op: 'check', collectors: [me(0.001, 0)] },
    { op: 'check', collectors: [me(0, 0)] },
    { op: 'check', collectors: [me(12.0001, 0)] },
    { op: 'check', collectors: [me(12, 0)] },
  ] },
  { name: 'random field, three collectors', ids: { kind: 'counter', prefix: 'rf' }, ops: randomOps(77) },
];
// Exact-boundary collector for 'radius edges': the drop's projected x plus the radius (2 units).
{
  const edge = DROP_SCENARIOS.find((s) => s.name === 'radius edges');
  const dx = DROP_PROJ.toWorld(edge.ops[2].drops[0].coordinate);
  edge.ops[6].collectors = [me(dx.x + 2, dx.z)];
  edge.ops[5].collectors = [me(dx.x + 2.0000001, dx.z)];
  edge.ops[4].collectors = [me(DROP_PROJ.toWorld(edge.ops[0].drops[0].coordinate).x, DROP_PROJ.toWorld(edge.ops[0].drops[0].coordinate).z)];
}
const drops = { scenarios: DROP_SCENARIOS.map(runDrops), MAX_ISSUED_COLLECT_IDS: D.MAX_ISSUED_COLLECT_IDS };

// ---------------------------------------------------------------------------
// geofences.json
// ---------------------------------------------------------------------------

const FENCE_PROJ = P.createProjection({ origin: { lng: 126.978, lat: 37.5665 }, unitMeters: 8 });

function runFences(sc) {
  const g = new G.GeofenceTracker();
  const results = [];
  for (const op of sc.ops) {
    if (op.op === 'set') {
      // Features.applyGeofences (specs) or world fences directly
      if (op.specs) op.fences = op.specs.map((s) => ({ id: s.id, ...FENCE_PROJ.toWorld(s.center), r: s.radiusMeters / 8 }));
      g.set(op.fences);
      results.push({ op: 'set' });
    } else {
      const events = g.update(op.characters).map((e) => ({ type: e.type, geofenceId: e.geofenceId, characterId: e.characterId }));
      const inside = g.list().map((f) => ({ id: f.id, inside: op.characters.map((c) => c.id).filter((id) => g.isInside(f.id, id)).sort() }));
      results.push({ op: 'update', events, inside });
    }
  }
  return { name: sc.name, unitMeters: 8, origin: FENCE_PROJ.origin, ops: sc.ops, results };
}

function walkOps(fences, from, to, steps, id = 'me') {
  const ops = [{ op: 'set', fences }];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    ops.push({ op: 'update', characters: [{ id, x: from[0] + (to[0] - from[0]) * t, z: from[1] + (to[1] - from[1]) * t }] });
  }
  return ops;
}

function randomFenceOps(seed) {
  const r = M.mulberry32(seed);
  const specs = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, center: FENCE_PROJ.toLngLat({ x: (r() - 0.5) * 60, z: (r() - 0.5) * 60 }), radiusMeters: 40 + r() * 120 }));
  const ops = [{ op: 'set', specs }];
  const chars = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, x: (r() - 0.5) * 60, z: (r() - 0.5) * 60 }));
  for (let f = 0; f < 250; f++) {
    for (const c of chars) { c.x += (r() - 0.5) * 4; c.z += (r() - 0.5) * 4; }
    const present = chars.filter((c, i) => !(i === 3 && f >= 100 && f < 140));
    ops.push({ op: 'update', characters: present.map((c) => ({ ...c })) });
    if (f === 120) ops.push({ op: 'set', specs: [specs[4], specs[1], { ...specs[2], radiusMeters: 10 }, { id: 'f9', center: specs[0].center, radiusMeters: 200 }] });
    if (f === 200) ops.push({ op: 'set', specs });
  }
  return ops;
}

const FENCE_SCENARIOS = [
  { name: 'walk through, exact radius is outside', ops: walkOps([{ id: 'plaza', x: 0, z: 0, r: 5 }], [-8, 0], [8, 0], 32) },
  { name: 'diagonal walk through two overlapping fences', ops: walkOps([{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 2, z: 1, r: 2.5 }], [-5, -4], [6, 5], 44) },
  { name: 'several characters and fences', ops: [
    { op: 'set', fences: [{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 10, z: 0, r: 3 }] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }, { id: 'npc', x: 10, z: 1 }] },
    { op: 'update', characters: [{ id: 'me', x: 10, z: 0 }, { id: 'npc', x: 10, z: 1 }] },
    { op: 'update', characters: [{ id: 'npc', x: 0, z: 2.999 }, { id: 'me', x: 13, z: 0 }] },
  ] },
  { name: 'setGeofences keeps membership of surviving ids', ops: [
    { op: 'set', fences: [{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 0, z: 0, r: 10 }] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }] },
    { op: 'set', fences: [{ id: 'a', x: 0, z: 0, r: 3 }] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }] },
    { op: 'set', fences: [{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 0, z: 0, r: 10 }] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }] },
    { op: 'set', fences: [{ id: 'b', x: 50, z: 0, r: 10 }, { id: 'a', x: 0, z: 0, r: 3 }] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }] },
    { op: 'update', characters: [] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }] },
  ] },
  { name: 'duplicate geofence ids share membership', ops: [
    { op: 'set', fences: [{ id: 'd', x: 0, z: 0, r: 3 }, { id: 'd', x: 20, z: 0, r: 3 }] },
    { op: 'update', characters: [{ id: 'me', x: 0, z: 0 }] },
    { op: 'update', characters: [{ id: 'me', x: 20, z: 0 }] },
    { op: 'update', characters: [{ id: 'me', x: 10, z: 0 }] },
  ] },
  { name: 'random walk with lng/lat specs', ops: randomFenceOps(5) },
];
const geofences = { scenarios: FENCE_SCENARIOS.map(runFences) };

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const files = {
  'travel-plan.json': { worlds: worldSpecs, plans, routes, snaps, helpers, times: planTimes },
  'travel-trace.json': { worlds: worldSpecs, traces },
  'location.json': { worlds: worldSpecs, ...location },
  'drops.json': drops,
  'geofences.json': geofences,
};
for (const [file, data] of Object.entries(files)) {
  const text = `${JSON.stringify(data)}\n`;
  writeFileSync(`${outDir}${outDir.endsWith('/') ? '' : '/'}${file}`, text);
  const count = data.plans?.length ?? data.traces?.length ?? data.scenarios?.length ?? data.smoother?.length ?? 0;
  console.log(`export-fixtures: ${file} (${count} entries, ${(text.length / 1024).toFixed(0)} KiB)`);
}
void median;
