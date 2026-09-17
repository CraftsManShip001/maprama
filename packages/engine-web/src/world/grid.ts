/**
 * Procedural `grid` layout: 9×9 street grid with 8×8 raised blocks, a central
 * plaza with the landmark, two parks, and rectangular lots (prototype
 * `buildGridWorld` + block/lot generation).
 *
 * @module
 */

import { mulberry32 } from '../util/math.js';
import { buildGraph, type GraphRoad } from './graph.js';
import { PROCEDURAL_ORIGIN, type BuildingModel, type GridBlock, type SceneryTree, type WorldModel } from './model.js';
import { rectCorners } from './polygon.js';
import { autoShapeFor, kindFor, roofFor } from './shapes.js';

const B = 10, O = -40, NN = 9;

/** Builds the procedural grid world. `seed` offsets the lot randomness (0 = prototype layout). */
export function buildGridWorld(seed = 0): WorldModel {
  const roads: GraphRoad[] = [];
  const ns = ['첫째길', '둘째길', '셋째길', '넷째길', '다섯째길', '여섯째길', '일곱째길', '여덟째길', '아홉째길'];
  for (let i = 0; i < NN; i++) {
    const cls = i % 4 === 0 ? 'arterial' : 'local';
    roads.push({ id: `grid:v${i}`, name: '새솔 ' + ns[i], cls, pts: [[-40 + i * 10, -40], [-40 + i * 10, 40]] });
    roads.push({ id: `grid:h${i}`, name: '은빛 ' + ns[i], cls, pts: [[-40, -40 + i * 10], [40, -40 + i * 10]] });
  }
  const graph = buildGraph(roads);

  const rng = mulberry32(11 + seed);
  const buildings: BuildingModel[] = [];
  const blocks: GridBlock[] = [];
  const add = (o: Omit<BuildingModel, 'idx' | 'footprint' | 'yaw' | 'id'> & { id?: string }): BuildingModel => {
    const idx = buildings.length;
    const w = o.rect?.w ?? 1, d = o.rect?.d ?? 1;
    const b: BuildingModel = { ...o, id: o.id ?? `grid:b${idx}`, idx, yaw: 0, footprint: rectCorners(o.x, o.z, 0, w, d) };
    buildings.push(b);
    return b;
  };
  const lotsFor = (x0: number, z0: number): { x: number; z: number; w: number; d: number }[] => {
    const inner = 7.4, s = x0 + 1.3, t = z0 + 1.3, p = rng();
    let cells: [number, number, number, number][];
    if (p < 0.18) cells = [[0, 0, 1, 1]];
    else if (p < 0.42) cells = [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]];
    else if (p < 0.62) cells = [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]];
    else cells = [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
    return cells.map(([u, v, w, d]) => {
      const gw = w * inner, gd = d * inner;
      return { x: s + u * inner + gw / 2, z: t + v * inner + gd / 2, w: gw - 0.8 - rng() * 0.7, d: gd - 0.8 - rng() * 0.7 };
    });
  };

  for (let bi = 0; bi < 8; bi++) for (let bj = 0; bj < 8; bj++) {
    const x0 = O + bi * B, z0 = O + bj * B;
    const kind: GridBlock['kind'] = bi === 4 && bj === 4 ? 'plaza' : (bi === 2 && bj === 5) || (bi === 6 && bj === 1) ? 'park' : 'city';
    blocks.push({ cx: x0 + 5, cz: z0 + 5, kind, bi, bj });
    if (kind === 'city') {
      for (const lot of lotsFor(x0, z0)) {
        const dist = Math.hypot(lot.x, lot.z);
        const h = (1.4 + Math.pow(rng(), 1.6) * 6.2) * (1 - Math.min(dist / 70, 0.45));
        const roof = roofFor(h, rng(), Math.min(lot.w, lot.d));
        const bkind = kindFor(h, roof, rng);
        const b = add({
          x: lot.x, z: lot.z, rect: { w: lot.w, d: lot.d }, h, roof, ci: Math.floor(rng() * 6), kind: bkind,
          decos: { sign: false, antenna: false, garden: false }, autoShape: 'box', landmark: false,
        });
        const q = rng();
        if (q < 0.14) b.decos.antenna = true;
        else if (q < 0.26 && roof === 'flat') b.decos.garden = true;
        else if (q < 0.36 && h < 3.6) b.decos.sign = true;
        b.autoShape = autoShapeFor(b.idx, h, lot.w, lot.d);
      }
    } else if (kind === 'plaza') {
      add({
        id: 'landmark', x: x0 + 5, z: z0 + 5, rect: { w: 5, d: 5 }, h: 8, roof: 'flat', ci: 0, kind: 'glass',
        decos: { sign: false, antenna: false, garden: false }, autoShape: 'box', landmark: true,
      });
    }
  }

  const sr = mulberry32(99);
  const trees: SceneryTree[] = [];
  for (const bl of blocks) {
    if (bl.kind === 'park') {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + sr() * 0.4, rr = 2.9 + sr() * 0.5;
        trees.push({ x: bl.cx + Math.cos(a) * rr, y: 0.14, z: bl.cz + Math.sin(a) * rr, s: 0.9 + sr() * 0.5 });
      }
    } else if (bl.kind === 'plaza') {
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) trees.push({ x: bl.cx + sx * 3.3, y: 0.14, z: bl.cz + sz * 3.3, s: 0.85 });
    }
  }
  for (let k = 0; k < 46; k++) {
    const a = sr() * Math.PI * 2, r = 47 + sr() * 50, s = 1.2 + sr() * 1.1;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.abs((((x - O) % B) + B) % B) < 1.6 || Math.abs((((z - O) % B) + B) % B) < 1.6) continue;
    trees.push({ x, y: 0, z, s, noOutline: true });
  }

  const stations = [{ id: 'grid:s0', name: '나루역', x: -10, z: -10 }, { id: 'grid:s1', name: '은빛역', x: 30, z: -30 }, { id: 'grid:s2', name: '새솔역', x: -30, z: 30 }, { id: 'grid:s3', name: '하늘역', x: 30, z: 30 }];
  return {
    kind: 'grid',
    name: 'Procedural grid',
    origin: { ...PROCEDURAL_ORIGIN },
    unitMeters: 8,
    bounds: { minX: -50, minZ: -50, maxX: 50, maxZ: 50 },
    graph,
    buildings,
    water: [],
    waterRims: null,
    waterRibbons: [],
    banks: [],
    pads: [],
    parks: [],
    plaza: { x: 5, z: 5, radius: 4 },
    gridBlocks: blocks,
    sceneryTrees: trees,
    ground: 'grass',
    buildingBaseY: 0.14,
    pois: [
      { id: 'grid:p0', name: '중앙 광장', cat: 'plaza', x: 5, z: 5 },
      { id: 'grid:p1', name: '물빛공원', cat: 'park', x: -15, z: 15 },
      { id: 'grid:p2', name: '솔마루 공원', cat: 'park', x: 25, z: -25 },
      ...stations.map((s, i) => ({ id: `grid:ps${i}`, name: s.name, cat: 'subway' as const, x: s.x, z: s.z })),
    ],
    stations,
    districts: [{ name: '새솔동', x: -22, z: -22 }, { name: '은빛동', x: 24, z: -20 }, { name: '나루동', x: -20, z: 22 }, { name: '하늘동', x: 26, z: 26 }],
    start: { x: -30, z: 0 },
    spawn: [[-24, 0], [-17, 0], [-9.5, 0], [-30, 7], [20, -6], [-2, -10], [14, 20]],
    loopWays: [[-30, 0], [20, 0], [20, 30], [-30, 30]],
    attribution: [],
  };
}
