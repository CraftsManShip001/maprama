/**
 * Procedural `town` layout: organic streets around a river with bridges,
 * parks, a plaza with the landmark, and buildings placed along street
 * frontages plus block infill (prototype `buildTownWorld` +
 * `buildTownBuildings`).
 *
 * @module
 */

import type { Vec2 } from '@diorama/protocol';
import { clamp, mulberry32 } from '../util/math.js';
import { buildGraph, ROAD_W, snap, type GraphRoad } from './graph.js';
import { PROCEDURAL_ORIGIN, type BuildingModel, type Ribbon, type SceneryTree, type WorldModel } from './model.js';
import { pointInPolygon, rectCorners } from './polygon.js';
import { autoShapeFor, kindFor, roofFor } from './shapes.js';

/** River centerline z at x. */
export const riverZ = (x: number): number => 44 + 7 * Math.sin(x / 38 + 0.6);

/** Builds the procedural town. `seed` offsets the randomness (0 = prototype layout). */
export function buildTownWorld(seed = 0): WorldModel {
  const roads: GraphRoad[] = [];
  const lr = mulberry32(2024 + seed), R = 72;
  let rid = 0;
  const road = (o: Omit<GraphRoad, 'id'>): void => { roads.push({ id: `town:r${rid++}`, ...o }); };
  const curve = (f: (x: number) => number, x0: number, x1: number, step: number): Vec2[] => {
    const p: Vec2[] = [];
    for (let x = x0; x <= x1 + 1e-6; x += step) p.push([x, f(x)]);
    return p;
  };
  road({ name: '강나루로', cls: 'arterial', pts: curve((x) => riverZ(x) - 11, -110, 110, 6) });
  road({ name: '남강변로', cls: 'arterial', pts: curve((x) => riverZ(x) + 12, -110, 110, 6) });
  road({ name: '은행나무길', cls: 'arterial', pts: [[-110, -18], [-30, -20], [10, -16], [110, -22]] });
  road({ name: '하늘로', cls: 'arterial', pts: [[2, -110], [0, -40], [-3, 0], [0, 20], [3, riverZ(3) - 11]] });
  road({ name: '새솔대로', cls: 'arterial', pts: [[-100, -96], [-20, -34], [70, 26]] });
  road({ name: '하늘대교', cls: 'arterial', bridge: true, pts: [[3, riverZ(3) - 11], [4, riverZ(4) + 12]] });
  road({ name: '나루교', cls: 'local', bridge: true, pts: [[-46, riverZ(-46) - 11], [-47, riverZ(-47) + 12]] });
  road({ name: '하늘로', cls: 'arterial', pts: [[4, riverZ(4) + 12], [6, 110]] });
  const vNames = ['모래내길', '느티길', '솔바람길', '골목시장길', '책방길', '은하수길', '별빛길', '다락길'];
  [-58, -44, -30, -15, 14, 28, 42, 57].forEach((x, k) => {
    const z1 = riverZ(x) - 10, pts: Vec2[] = [];
    for (let z = -R; z < z1; z += 12) pts.push([x + (lr() - 0.5) * 4, z]);
    pts.push([x + (lr() - 0.5) * 2, z1]);
    if (lr() < 0.35) {
      const cut = 1 + Math.floor(lr() * (pts.length - 3));
      road({ name: vNames[k]!, cls: 'local', pts: pts.slice(0, cut + 1) });
      road({ name: vNames[k]!, cls: 'local', pts: pts.slice(cut + 2) });
    } else road({ name: vNames[k]!, cls: 'local', pts });
  });
  const hNames = ['물빛로', '다온길', '꽃담길', '새벽길', '마루길', '한별길'];
  [-58, -44, -31, -6, 8, 24].forEach((z, k) => {
    const x0 = -R + (lr() < 0.3 ? lr() * 30 : 0), x1 = R - (lr() < 0.3 ? lr() * 30 : 0), pts: Vec2[] = [];
    for (let x = x0; x < x1; x += 14) pts.push([x, z + (lr() - 0.5) * 4]);
    pts.push([x1, z + (lr() - 0.5) * 2]);
    road({ name: hNames[k]!, cls: 'local', pts: pts.filter((p) => p[1] < riverZ(p[0]) - 11.5) });
  });
  [-34, -12, 20, 44].forEach((x, k) =>
    road({ name: ['나루1길', '나루2길', '나루3길', '나루4길'][k]!, cls: 'local', pts: [[x, riverZ(x) + 11], [x + (lr() - 0.5) * 6, 80], [x + (lr() - 0.5) * 6, 104]] }),
  );
  road({ name: '강변남길', cls: 'local', pts: [[-70, 78], [-20, 82], [30, 76], [80, 80]] });
  for (let k = 0; k < 9; k++) {
    const x = -60 + lr() * 120, z = -64 + lr() * 80, a = lr() * Math.PI * 2, L = 8 + lr() * 6;
    if (z > riverZ(x) - 16) continue;
    road({ name: '골목', cls: 'alley', pts: [[x, z], [x + Math.cos(a) * L * 0.5, z + Math.sin(a) * L * 0.5 + 1.5], [x + Math.cos(a) * L, z + Math.sin(a) * L]] });
  }
  const graph = buildGraph(roads.filter((r) => r.pts.length > 1));
  const plaza = { x: 8.5, z: 1, radius: 6.4 };
  const parks = [
    { name: '솔마루 공원', poly: [[-41, -3.5], [-33, -4.5], [-32, 5.5], [-40.5, 6]] as Vec2[] },
    { name: '다온 어린이공원', poly: [[31, -40], [39.5, -41], [40, -34], [31.5, -33]] as Vec2[] },
  ];

  // ---- building placement along street frontages ----
  const buildings: BuildingModel[] = [];
  const RES = 0.5, EXT = 115, N = Math.round((EXT * 2) / RES), occ = new Uint8Array(N * N);
  const cell = (x: number, z: number): number => {
    const i = Math.floor((x + EXT) / RES), j = Math.floor((z + EXT) / RES);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : i * N + j;
  };
  const markCapsule = (ax: number, az: number, bx: number, bz: number, r: number): void => {
    const x0 = Math.min(ax, bx) - r, x1 = Math.max(ax, bx) + r, z0 = Math.min(az, bz) - r, z1 = Math.max(az, bz) + r;
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    for (let x = x0; x <= x1; x += RES) for (let z = z0; z <= z1; z += RES) {
      const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1), px = ax + dx * t - x, pz = az + dz * t - z;
      if (px * px + pz * pz <= r * r) { const c = cell(x, z); if (c >= 0) occ[c] = 1; }
    }
  };
  const rectPoints = (cx: number, cz: number, yaw: number, w: number, d: number, fn: (x: number, z: number) => boolean | void): boolean => {
    const ax = Math.cos(yaw), az = -Math.sin(yaw), bx = Math.sin(yaw), bz = Math.cos(yaw);
    for (let u = -w / 2; u <= w / 2 + 1e-6; u += RES) for (let v = -d / 2; v <= d / 2 + 1e-6; v += RES) {
      if (fn(cx + ax * u + bx * v, cz + az * u + bz * v) === false) return false;
    }
    return true;
  };
  const inDistrict = (x: number, z: number): boolean => Math.abs(x) < 86 && z > -86 && z < 108 && (z < riverZ(x) - 8.5 || z > riverZ(x) + 9);
  const isFree = (x: number, z: number): boolean => { const c = cell(x, z); return c >= 0 && !occ[c] && inDistrict(x, z); };
  const mark = (x: number, z: number): void => { const c = cell(x, z); if (c >= 0) occ[c] = 1; };

  for (const e of graph.edges) {
    const A = graph.nodes[e.a]!, Bn = graph.nodes[e.b]!;
    markCapsule(A.x, A.z, Bn.x, Bn.z, ROAD_W[e.cls] / 2 + 0.95);
  }
  for (let x = -EXT; x < EXT; x += 1) markCapsule(x, riverZ(x), x + 1, riverZ(x + 1), 8.6);
  for (const p of parks) for (let x = -EXT; x < EXT; x += RES) for (let z = -EXT; z < EXT; z += RES) if (pointInPolygon(x, z, p.poly)) mark(x, z);
  markCapsule(plaza.x, plaza.z, plaza.x, plaza.z, 6.2);

  const add = (o: { x: number; z: number; w: number; d: number; yaw: number; h: number; roof: BuildingModel['roof']; ci: number; kind: BuildingModel['kind']; landmark?: boolean; id?: string }): BuildingModel => {
    const idx = buildings.length;
    const b: BuildingModel = {
      id: o.id ?? `town:b${idx}`, idx, x: o.x, z: o.z, yaw: o.yaw, rect: { w: o.w, d: o.d },
      footprint: rectCorners(o.x, o.z, o.yaw, o.w, o.d), h: o.h, kind: o.kind, roof: o.roof, ci: o.ci,
      decos: { sign: false, antenna: false, garden: false }, autoShape: 'box', landmark: !!o.landmark,
    };
    buildings.push(b);
    return b;
  };
  add({ id: 'landmark', x: plaza.x, z: plaza.z, w: 5, d: 5, yaw: 0, h: 8, roof: 'flat', ci: 0, kind: 'glass', landmark: true });

  const r = mulberry32(77 + seed);
  const order = graph.edges.map((_, i) => i).sort((i, j) => {
    const ma = graph.nodes[graph.edges[i]!.a]!, mb = graph.nodes[graph.edges[j]!.a]!;
    return Math.hypot(ma.x, ma.z) - Math.hypot(mb.x, mb.z);
  });
  for (const ei of order) {
    const e = graph.edges[ei]!;
    if (e.bridge) continue;
    const A = graph.nodes[e.a]!, Bn = graph.nodes[e.b]!, len = e.len;
    if (len < 3.5) continue;
    const ux = (Bn.x - A.x) / len, uz = (Bn.z - A.z) / len;
    for (const side of [1, -1]) {
      let s = 1.3;
      while (s < len - 1.3 && buildings.length < 340) {
        const fw = 2.4 + r() * 3.6, depth = 2.8 + r() * (e.cls === 'arterial' ? 4.6 : 3.4);
        if (s + fw > len - 1.0) break;
        const nx = -uz * side, nz = ux * side, off = ROAD_W[e.cls] / 2 + 1.0 + depth / 2;
        const px = A.x + ux * (s + fw / 2) + nx * off, pz = A.z + uz * (s + fw / 2) + nz * off, yaw = Math.atan2(-nx, -nz);
        const free = inDistrict(px, pz) && rectPoints(px, pz, yaw, fw + 0.5, depth + 0.4, isFree);
        if (!free) { s += 1.1; continue; }
        rectPoints(px, pz, yaw, fw + 0.5, depth + 0.4, mark);
        const center = 1.25 - Math.min(Math.hypot(px, pz) / 110, 0.55);
        const h = (e.cls === 'arterial' ? 3.2 + Math.pow(r(), 1.3) * 6.5 : e.cls === 'local' ? 1.5 + Math.pow(r(), 1.8) * 4.6 : 1.2 + r() * 1.8) * center;
        const roof = roofFor(h, r(), Math.min(fw, depth));
        const kind = kindFor(h, roof, r);
        const b = add({ x: px, z: pz, w: fw, d: depth, yaw, h, roof, ci: Math.floor(r() * 6), kind });
        const dq = r();
        if (dq < 0.12) b.decos.antenna = true;
        else if (dq < 0.22 && roof === 'flat') b.decos.garden = true;
        else if (dq < 0.4 && h < 3.6) b.decos.sign = true;
        b.autoShape = autoShapeFor(b.idx, h, fw, depth);
        s += fw + 0.45;
      }
    }
  }
  // infill: fill block interiors so blocks don't read as empty lots
  for (let k = 0; k < 1400 && buildings.length < 460; k++) {
    const px = (r() - 0.5) * 150, pz = -74 + r() * 176;
    if (!inDistrict(px, pz) || Math.hypot(px - plaza.x, pz - plaza.z) < 8) continue;
    const sn = snap(graph, px, pz);
    if (!sn) continue;
    const dToRoad = Math.hypot(sn.x - px, sn.z - pz);
    if (dToRoad < 4 || dToRoad > 16) continue;
    const yaw = Math.atan2(sn.x - px, sn.z - pz), fw = 2.4 + r() * 3.2, depth = 2.4 + r() * 3.2;
    if (!rectPoints(px, pz, yaw, fw + 0.6, depth + 0.6, isFree)) continue;
    rectPoints(px, pz, yaw, fw + 0.6, depth + 0.6, mark);
    const h = (1.4 + Math.pow(r(), 1.7) * 3.6) * (1.15 - Math.min(Math.hypot(px, pz) / 120, 0.5));
    const roof = h > 3.6 || r() < 0.55 ? 'flat' : 'gable';
    const kind = h > 3.2 ? (r() < 0.6 ? 'apartment' : 'office') : roof === 'gable' ? 'brick' : 'office';
    const b = add({ x: px, z: pz, w: fw, d: depth, yaw, h, roof, ci: Math.floor(r() * 6), kind });
    if (r() < 0.15 && roof === 'flat') b.decos.garden = true;
    b.autoShape = autoShapeFor(b.idx, h, fw, depth, true);
  }

  // ---- landuse ----
  const north: Vec2[] = [[-92, -92], [92, -92]];
  const south: Vec2[] = [[-92, 112], [92, 112]];
  for (let x = 92; x >= -92; x -= 6) { north.push([x, riverZ(x) - 8]); south.push([x, riverZ(x) + 8]); }
  const riverPts: Vec2[] = [];
  for (let x = -160; x <= 160; x += 4) riverPts.push([x, riverZ(x)]);
  const waterRibbons: Ribbon[] = [{ pts: riverPts, width: 13 }];
  const banks: Ribbon[] = [{ pts: riverPts, width: 18 }];
  const sr = mulberry32(991 + seed);
  const trees: SceneryTree[] = [];
  for (let x = -80; x < 80; x += 7) if (sr() < 0.7) trees.push({ x: x + sr() * 3, y: 0.02, z: riverZ(x) - 7.3, s: 0.7 + sr() * 0.4 });

  const stations = [
    { id: 'town:s0', name: '나루역', x: -5, z: -21 }, { id: 'town:s1', name: '강변역', x: 42, z: riverZ(42) - 15 },
    { id: 'town:s2', name: '새솔역', x: -50, z: -52 }, { id: 'town:s3', name: '하늘역', x: 6, z: 80 },
  ];
  return {
    kind: 'town',
    name: 'Procedural town',
    origin: { ...PROCEDURAL_ORIGIN },
    unitMeters: 8,
    bounds: { minX: -110, minZ: -110, maxX: 110, maxZ: 110 },
    graph,
    buildings,
    water: [],
    waterRibbons,
    banks,
    pads: [north, south],
    parks,
    plaza,
    gridBlocks: null,
    sceneryTrees: trees,
    ground: 'lawn',
    buildingBaseY: 0.06,
    pois: [
      { id: 'town:p0', name: '나루역', cat: 'subway', x: -5, z: -21 }, { id: 'town:p1', name: '모퉁이 커피', cat: 'cafe', x: -18, z: -9 },
      { id: 'town:p2', name: '24 편의점', cat: 'store', x: 16, z: -30 }, { id: 'town:p3', name: '동네 LP숍', cat: 'music', x: -30, z: 10 },
      { id: 'town:p4', name: '새솔초등학교', cat: 'school', x: -50, z: -38 }, { id: 'town:p5', name: '골목서점', cat: 'book', x: 30, z: 14 },
      { id: 'town:p6', name: '중앙 광장', cat: 'plaza', x: 8.5, z: 1 }, { id: 'town:p7', name: '솔마루 공원', cat: 'park', x: -36.5, z: 1 },
      { id: 'town:p8', name: '강변 수변공원', cat: 'park', x: 40, z: riverZ(40) - 6 },
      { id: 'town:p9', name: '강변역', cat: 'subway', x: 42, z: riverZ(42) - 15 }, { id: 'town:p10', name: '새솔역', cat: 'subway', x: -50, z: -52 },
      { id: 'town:p11', name: '하늘역', cat: 'subway', x: 6, z: 80 },
    ],
    stations,
    districts: [
      { name: '새솔동', x: -40, z: -45 }, { name: '은빛동', x: 38, z: -50 }, { name: '나루동', x: -38, z: 14 }, { name: '하늘동', x: 38, z: 8 },
      { name: '강남 나루마을', x: -10, z: 92 }, { name: '푸른강', x: -60, z: riverZ(-60), water: true },
    ],
    start: { x: -30, z: -19 },
    spawn: [[-24, -19.5], [-17, -20], [-9, -19], [-2, -18], [14, -8], [14, 6], [-15, -30]],
    loopWays: [[-30, -19], [14, -17], [14, 22], [-30, 23]],
    attribution: [],
  };
}
