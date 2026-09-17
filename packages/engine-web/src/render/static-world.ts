/**
 * Static world renderer for every world source: ground and landuse pads,
 * water, banks, parks, plaza, grid block pads, road ribbons (sidewalk casing,
 * per-class strips, node discs), lane markings, crosswalks, bridges, scenery
 * and street trees, street lamps with night glow, parked cars, benches and
 * bus stops. Ported from the prototype's `rebuildStatic` / `rebuildStaticTown`.
 *
 * @module
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import type { RoadClass, Vec2 } from '@maprama/protocol';
import { cssHexToNumber, mixHex, mulberry32, scaleHex } from '../util/math.js';
import { ROAD_W } from '../world/graph.js';
import { bbox, pointInPolygon, signedArea } from '../world/polygon.js';
import { ACCENT } from '../theme/materials.js';
import { discsGeo, mergeFlat, polyGeo, quadsGeo, ribbonGeo, type Disc, type Quad } from './geometry.js';
import { prismGeometry } from './footprint.js';
import { addPart, CAR_COLORS, clearGroup, noRaycast, sharedGeometries, tree, type RenderContext } from './parts.js';

const ROAD_Y: Record<RoadClass, number> = { alley: 0.07, local: 0.075, arterial: 0.08 };
const MARK_Y = 0.09;
/**
 * Shortest an overview block is drawn, in world units (~8 m, one low storey).
 * A tile can carry a height of zero where OSM had none, and a zero-height prism
 * is a cap coplanar with the pad under it — z-fighting, not a building.
 */
const BUILDING_FILL_MIN_H = 1;

export class StaticWorldRenderer {
  /** Ground, water, roads, markings, bridges, trees. */
  readonly group = new Group();
  /** Small street clutter (lamps, parked cars, benches, bus stops) hidden when zoomed far out. */
  readonly clutter = new Group();
  /**
   * The overview's merged building blocks (`WorldModel.buildingFills`), or
   * `null` when the world has none. Exposed so the engine can squash and hide
   * them with the modelled buildings: they are buildings, and a view that
   * flattens one and not the other would be two maps at once.
   */
  blocks: Mesh | null = null;

  constructor() {
    this.group.name = 'static';
    this.clutter.name = 'clutter';
    this.group.add(this.clutter);
  }

  /** Removes and disposes everything built so far. */
  clear(): void {
    clearGroup(this.clutter);
    clearGroup(this.group);
    this.group.add(this.clutter);
    this.blocks = null;
  }

  build(ctx: RenderContext): void {
    this.clear();
    const { params: P, mats, world: W } = ctx;
    const T = P.preset;
    const sr = mulberry32(99);
    const flat = (geo: BufferGeometry, mat: Material, receive = true): Mesh => {
      const m = new Mesh(geo, mat);
      m.receiveShadow = receive;
      m.raycast = noRaycast;
      this.group.add(m);
      return m;
    };
    const padCol = T.textured ? 0xc4c1ba : T.pad;
    const roadCol = T.textured ? 0x55585e : T.road;
    const { minX, minZ, maxX, maxZ } = W.bounds;
    const extent = Math.max(maxX - minX, maxZ - minZ);
    const gx = (minX + maxX) / 2, gz = (minZ + maxZ) / 2;

    // ---- ground ----
    if (W.ground === 'grass') {
      flat(new PlaneGeometry(460, 460).rotateX(-Math.PI / 2), mats.make(T.ground, T.textured ? { map: ctx.tex.grass, roughness: 1 } : { roughness: 1 }));
    } else {
      const size = Math.max(520, extent * 3);
      flat(new PlaneGeometry(size, size).rotateX(-Math.PI / 2).translate(gx, 0, gz), mats.make(T.textured ? 0x86a56e : T.ground, { roughness: 1 }));
    }
    const padMat = mats.make(padCol, { roughness: 0.95 });
    for (const pad of W.pads) flat(polyGeo(pad, 0.01), padMat);

    // ---- water ----
    const parkMat = mats.make(T.park, { roughness: 1 });
    for (const bank of W.banks) flat(ribbonGeo(bank.pts, bank.width, 0.02, false), parkMat);
    const wm = mats.make(T.water, { roughness: 0.1, metalness: 0.3 });
    for (const rib of W.waterRibbons) flat(ribbonGeo(rib.pts, rib.width, 0.03), wm);
    // The rim is the closed ring of every water polygon — unless the world
    // supplies its own rim polylines. A tile world does, because a river cut at
    // a tile edge must not grow a bank along the cut (`WorldModel.waterRims`).
    if (W.waterRims) for (const rim of W.waterRims) if (rim.length >= 2) flat(ribbonGeo(rim, 2.4, 0.02), parkMat);
    for (const poly of W.water) {
      if (!W.waterRims) flat(ribbonGeo([...poly, poly[0]!], 2.4, 0.02), parkMat);
      flat(polyGeo(poly, 0.03), wm);
    }

    // ---- parks ----
    for (const p of W.parks) {
      flat(polyGeo(p.poly, 0.05), parkMat);
      const bb = bbox(p.poly);
      const area = Math.abs(signedArea(p.poly));
      const n = Math.max(3, Math.min(60, Math.round(area / 10)));
      let placed = 0;
      for (let k = 0; k < n * 6 && placed < n; k++) {
        const x = bb.minX + sr() * (bb.maxX - bb.minX), z = bb.minZ + sr() * (bb.maxZ - bb.minZ);
        if (!pointInPolygon(x, z, p.poly)) continue;
        tree(ctx, this.group, x, 0.05, z, 0.8 + sr() * 0.5, sr);
        placed++;
      }
    }
    // ---- merged building blocks (the overview's un-modelled mass) ----
    //
    // Everything the overview's per-tile budget dropped, extruded to its real
    // height and merged into **one mesh**: one draw call in the colour pass and
    // one in the shadow pass, for what the 2.5D renderer would have drawn as
    // thousands of groups. No facade, no roof furniture, no parapet, no outline
    // and no contact decal — at 7 km none of that is a pixel; what does the work
    // is the silhouette and the shadow, and those are here.
    //
    // A flat fill was tried first and is not enough: a cap at ground level is
    // unlit mass in a lit scene, and at the overview's haze it washes out to a
    // mottle on the paving (measured: the block colour landed 10 of 255 from the
    // pad, and the screenshots showed exactly that).
    if (W.buildingFills?.length) {
      // Built from y = 0 and lifted by the mesh's own position, so that
      // `blocks.scale.y` squashes them about their base — which is how the
      // zoom-out behaviour and the 2D view move the modelled buildings.
      const geos = W.buildingFills.map((f) => prismGeometry(f.ring, 0, Math.max(f.h * P.heightScale, BUILDING_FILL_MIN_H)));
      // The theme's own building colour, toned towards the paving: one merged
      // mesh can carry only one colour, and the palette's first entry alone
      // (white, in every preset) reads brighter than the modelled buildings it
      // stands between, which are shaded by their facades.
      const block = new Mesh(mergeFlat(geos), mats.make(mixHex(cssHexToNumber(P.palette[0]!), padCol, 0.3), { roughness: 0.85 }));
      block.position.y = W.buildingBaseY;
      block.castShadow = true;
      block.receiveShadow = true;
      block.raycast = noRaycast;
      this.group.add(block);
      this.blocks = block;
    }

    if (W.plaza && !W.gridBlocks) {
      flat(discsGeo([[W.plaza.x, W.plaza.z, W.plaza.radius]], 0.06, 40), mats.make(T.textured ? 0xcfc6b8 : T.plaza, { roughness: 0.9 }));
    }
    for (const t of W.sceneryTrees) tree(ctx, this.group, t.x, t.y, t.z, t.s, sr, t.noOutline);

    // ---- grid block pads ----
    if (W.gridBlocks) {
      const tx = T.textured;
      for (const bl of W.gridBlocks) {
        const padExtra = !tx ? { roughness: 0.95 } : bl.kind === 'city' ? { map: ctx.tex.sidewalk, roughness: 0.95 } : bl.kind === 'plaza' ? { map: ctx.tex.stone, roughness: 0.9 } : { map: ctx.tex.grassPad, roughness: 1 };
        const key = bl.kind === 'city' ? 'pad' : bl.kind;
        const pad = addPart(ctx, this.group, new BoxGeometry(8, 0.14, 8).translate(bl.cx, 0.07, bl.cz), mats.themed(key, padExtra), { cast: false, receive: true, outline: 0.05 });
        pad.raycast = noRaycast;
        if (bl.kind === 'park') {
          const pond = flat(new CircleGeometry(2.1, 40).rotateX(-Math.PI / 2), mats.make(T.water, { roughness: 0.12, metalness: 0.25 }));
          pond.position.set(bl.cx, 0.155, bl.cz);
          const rim = flat(new CircleGeometry(2.3, 40).rotateX(-Math.PI / 2), T.shading === 'toon' ? mats.basic({ color: T.rim }) : mats.make(T.rim, { roughness: 0.9 }));
          rim.position.set(bl.cx, 0.148, bl.cz);
        }
      }
    }

    // ---- roads ----
    const G = W.graph;
    const walkQ: Quad[] = [], walkD: Disc[] = [];
    const roadQ: Record<RoadClass, Quad[]> = { alley: [], local: [], arterial: [] };
    const roadD: Record<RoadClass, Disc[]> = { alley: [], local: [], arterial: [] };
    for (const e of G.edges) {
      const A = G.nodes[e.a]!, B = G.nodes[e.b]!, w = ROAD_W[e.cls];
      if (!e.bridge) walkQ.push([A.x, A.z, B.x, B.z, w + 1.9]);
      roadQ[e.cls].push([A.x, A.z, B.x, B.z, w]);
    }
    G.nodes.forEach((n, i) => {
      const adj = G.adj[i]!;
      if (!adj.length) return;
      const cls = adj.map((ei) => G.edges[ei]!.cls).sort((a, b) => ROAD_W[b] - ROAD_W[a])[0]!;
      walkD.push([n.x, n.z, (ROAD_W[cls] + 1.9) / 2]);
      roadD[cls].push([n.x, n.z, ROAD_W[cls] / 2]);
    });
    const walkM = mats.make(scaleHex(padCol, 0.9), { roughness: 0.95 });
    flat(quadsGeo(walkQ, 0.055), walkM);
    flat(discsGeo(walkD, 0.055), walkM);
    for (const cls of ['alley', 'local', 'arterial'] as const) {
      const rm = mats.make(cls === 'alley' ? mixHex(roadCol, padCol, 0.45) : roadCol, { roughness: 0.92 });
      flat(quadsGeo(roadQ[cls], ROAD_Y[cls]), rm);
      flat(discsGeo(roadD[cls], ROAD_Y[cls]), rm);
    }

    if (P.roads.laneMarkings) {
      const yellow: Quad[] = [], white: Quad[] = [];
      for (const e of G.edges) {
        if (e.cls === 'alley') continue;
        const A = G.nodes[e.a]!, B = G.nodes[e.b]!, ux = (B.x - A.x) / e.len, uz = (B.z - A.z) / e.len, nx = -uz, nz = ux;
        const s0 = ROAD_W[e.cls] / 2 + 1.2, s1 = e.len - s0;
        if (s1 <= s0) continue;
        if (e.cls === 'arterial') {
          for (const o of [0.08, -0.08]) yellow.push([A.x + ux * s0 + nx * o, A.z + uz * s0 + nz * o, A.x + ux * s1 + nx * o, A.z + uz * s1 + nz * o, 0.06]);
          for (const o of [1.2, -1.2]) white.push([A.x + ux * s0 + nx * o, A.z + uz * s0 + nz * o, A.x + ux * s1 + nx * o, A.z + uz * s1 + nz * o, 0.05]);
        } else for (let s = s0; s + 0.9 < s1; s += 1.8) white.push([A.x + ux * s, A.z + uz * s, A.x + ux * (s + 0.9), A.z + uz * (s + 0.9), 0.1]);
      }
      if (T.centerLine !== T.road || T.textured) flat(quadsGeo(yellow, MARK_Y), mats.basic({ color: T.centerLine }), false);
      flat(quadsGeo(white, MARK_Y), mats.basic({ color: T.crosswalkColor }), false);
    }
    if (P.roads.crosswalks) {
      const stripes: Quad[] = [];
      G.nodes.forEach((n, i) => {
        const adj = G.adj[i]!;
        if (adj.length < 3) return;
        const maxW = Math.max(...adj.map((ei) => ROAD_W[G.edges[ei]!.cls]));
        for (const ei of adj) {
          const e = G.edges[ei]!;
          if (e.cls === 'alley' || e.len < maxW + 3) continue;
          const o = G.nodes[e.a === i ? e.b : e.a]!, ux = (o.x - n.x) / e.len, uz = (o.z - n.z) / e.len, nx = -uz, nz = ux, w = ROAD_W[e.cls], c = maxW / 2 + 0.75;
          for (let k = -w / 2 + 0.2; k <= w / 2 - 0.15; k += 0.3) {
            stripes.push([n.x + ux * (c - 0.4) + nx * k, n.z + uz * (c - 0.4) + nz * k, n.x + ux * (c + 0.4) + nx * k, n.z + uz * (c + 0.4) + nz * k, 0.16]);
          }
        }
      });
      flat(quadsGeo(stripes, MARK_Y + 0.002), mats.basic({ color: T.crosswalkColor }), false);
    }

    // ---- bridges ----
    const deckM = mats.make(0xa3a7ab, { roughness: 0.8 }), railM = mats.make(0xdadde0, { roughness: 0.5, metalness: 0.3 });
    for (const e of G.edges) {
      if (!e.bridge) continue;
      const A = G.nodes[e.a]!, B = G.nodes[e.b]!, mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2, yaw = Math.atan2(B.x - A.x, B.z - A.z), w = ROAD_W[e.cls] + 1.2;
      const g = new Group();
      g.position.set(mx, 0, mz);
      g.rotation.y = yaw;
      this.group.add(g);
      addPart(ctx, g, new BoxGeometry(w, 0.1, e.len).translate(0, 0.02, 0), deckM, { outline: 0, receive: true });
      for (const sx of [-1, 1]) addPart(ctx, g, new BoxGeometry(0.08, 0.28, e.len).translate((sx * w) / 2, 0.2, 0), railM, { outline: 0 });
      for (let s = -e.len / 2 + 4; s < e.len / 2 - 3; s += 7) addPart(ctx, g, new CylinderGeometry(0.35, 0.45, 0.5, 10).translate(0, -0.2, s), deckM, { outline: 0 });
    }

    // ---- street props ----
    const baseY = W.gridBlocks ? 0.14 : 0.06;
    const d = new Object3D();
    const SG = sharedGeometries();
    const lit = P.lights;
    if (P.street.props) {
      const spots: [number, number, number][] = [], lamps: [number, number, number][] = [];
      for (const e of G.edges) {
        if (e.bridge || e.cls === 'alley') continue;
        const A = G.nodes[e.a]!, B = G.nodes[e.b]!, ux = (B.x - A.x) / e.len, uz = (B.z - A.z) / e.len, nx = -uz, nz = ux, off = ROAD_W[e.cls] / 2 + 0.55;
        for (let s = 2.8; s < e.len - 2.8; s += 5) for (const side of [1, -1]) spots.push([A.x + ux * s + nx * off * side, A.z + uz * s + nz * off * side, 0.46 + sr() * 0.14]);
        if (e.cls === 'arterial') for (let s = 4; s < e.len - 3; s += 9) lamps.push([A.x + ux * s + nx * (off + 0.2), A.z + uz * s + nz * (off + 0.2), Math.atan2(nx, nz) + Math.PI / 2]);
      }
      if (spots.length) {
        const trunkI = new InstancedMesh(SG.trunk, mats.make(T.trunk), spots.length);
        const crownI = new InstancedMesh(SG.crown, mats.make(0xffffff, { roughness: 1 }), spots.length);
        const cA = new Color(T.leafA), cB = new Color(T.leafB), tc = new Color();
        spots.forEach(([x, z, s], i) => {
          d.position.set(x, baseY, z);
          d.rotation.set(0, sr() * 6, 0);
          d.scale.set(s, s * (0.9 + sr() * 0.3), s);
          d.updateMatrix();
          trunkI.setMatrixAt(i, d.matrix);
          crownI.setMatrixAt(i, d.matrix);
          tc.copy(cA).lerp(cB, sr());
          crownI.setColorAt(i, tc);
        });
        d.scale.set(1, 1, 1);
        trunkI.castShadow = crownI.castShadow = true;
        crownI.receiveShadow = true;
        trunkI.raycast = crownI.raycast = noRaycast;
        this.group.add(trunkI, crownI);
      }
      if (lamps.length) {
        const poles = new InstancedMesh(new CylinderGeometry(0.03, 0.045, 1.55, 6).translate(0, 0.775, 0), mats.make(0x4e5256, { roughness: 0.6, metalness: 0.4 }), lamps.length);
        const heads = new InstancedMesh(new BoxGeometry(0.36, 0.06, 0.12).translate(-0.14, 1.55, 0), mats.basic({ color: lit > 0 ? 0xffe6b8 : 0x8e9398 }), lamps.length);
        const glows = new InstancedMesh(
          new PlaneGeometry(4.4, 4.4).rotateX(-Math.PI / 2),
          mats.basic({ color: 0xffb060, map: ctx.tex.glow, transparent: true, opacity: Math.min(0.8, lit * 0.55), blending: AdditiveBlending, depthWrite: false }),
          lamps.length,
        );
        lamps.forEach(([x, z, yaw], i) => {
          d.position.set(x, baseY, z);
          d.rotation.set(0, yaw, 0);
          d.updateMatrix();
          poles.setMatrixAt(i, d.matrix);
          heads.setMatrixAt(i, d.matrix);
          d.position.set(x, baseY + 0.04, z);
          d.rotation.set(0, 0, 0);
          d.updateMatrix();
          glows.setMatrixAt(i, d.matrix);
        });
        poles.castShadow = true;
        glows.visible = lit > 0;
        glows.renderOrder = 2;
        poles.raycast = heads.raycast = glows.raycast = noRaycast;
        this.clutter.add(poles, heads, glows);
      }
    }

    if (P.street.parked) {
      const ps = mulberry32(404), cars: [number, number, number][] = [];
      for (const e of G.edges) {
        if (e.cls !== 'local' || e.bridge) continue;
        const A = G.nodes[e.a]!, B = G.nodes[e.b]!, ux = (B.x - A.x) / e.len, uz = (B.z - A.z) / e.len, nx = -uz, nz = ux;
        for (let s = 3.5; s < e.len - 3.5; s += 3.2) if (ps() < 0.28) {
          const side = ps() < 0.5 ? 1 : -1;
          cars.push([A.x + ux * s + nx * 0.72 * side, A.z + uz * s + nz * 0.72 * side, Math.atan2(ux * side, uz * side)]);
        }
      }
      if (cars.length) {
        const bodyI = new InstancedMesh(SG.carBody, mats.make(0xffffff, { roughness: 0.35, metalness: 0.2 }), cars.length);
        const cabI = new InstancedMesh(SG.carCab, mats.make(0x27313b, { roughness: 0.12, metalness: 0.4 }), cars.length);
        const colors = CAR_COLORS.map((c) => new Color(c));
        cars.forEach(([x, z, yaw], k) => {
          d.position.set(x, 0.08, z);
          d.rotation.set(0, yaw, 0);
          d.updateMatrix();
          bodyI.setMatrixAt(k, d.matrix);
          cabI.setMatrixAt(k, d.matrix);
          bodyI.setColorAt(k, colors[(ps() * colors.length) | 0]!);
        });
        bodyI.castShadow = cabI.castShadow = true;
        bodyI.raycast = cabI.raycast = noRaycast;
        this.clutter.add(bodyI, cabI);
      }

      // benches around the plaza and parks
      const wood = mats.make(0x9c7b5b, { roughness: 0.8 });
      const benches: [number, number, number][] = [];
      const ringBenches = (cx: number, cz: number, r: number, n: number, a0: number): void => {
        for (let q = 0; q < n; q++) {
          const a = (q / n) * Math.PI * 2 + a0, dx = Math.cos(a), dz = Math.sin(a);
          benches.push([cx + dx * r, cz + dz * r, Math.atan2(-dx, -dz)]);
        }
      };
      if (W.gridBlocks) {
        for (const bl of W.gridBlocks) {
          if (bl.kind === 'plaza') for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) benches.push([bl.cx + sx * 3.35, bl.cz + sz * 3.35, Math.atan2(-sx, -sz)]);
          if (bl.kind === 'park') ringBenches(bl.cx, bl.cz, 2.55, 4, 0.4);
        }
      } else {
        if (W.plaza) ringBenches(W.plaza.x, W.plaza.z, W.plaza.radius - 0.9, 6, 0.3);
        for (const p of W.parks) {
          const c = p.poly.reduce((s, q) => [s[0] + q[0] / p.poly.length, s[1] + q[1] / p.poly.length] as Vec2, [0, 0] as Vec2);
          ringBenches(c[0], c[1], 2.2, 3, 0.4);
        }
      }
      const benchY = W.gridBlocks ? 0.14 : 0.06;
      if (benches.length) {
        const seatI = new InstancedMesh(new BoxGeometry(0.62, 0.05, 0.18).translate(0, 0.2, 0), wood, benches.length);
        const backI = new InstancedMesh(new BoxGeometry(0.62, 0.18, 0.04).translate(0, 0.33, -0.08), wood, benches.length);
        benches.forEach(([x, z, yaw], k) => {
          d.position.set(x, benchY, z);
          d.rotation.set(0, yaw, 0);
          d.updateMatrix();
          seatI.setMatrixAt(k, d.matrix);
          backI.setMatrixAt(k, d.matrix);
        });
        seatI.castShadow = backI.castShadow = true;
        seatI.raycast = backI.raycast = noRaycast;
        this.clutter.add(seatI, backI);
      }

      // bus stops along arterials
      const glass = mats.basic({ color: 0xbfd8e4, transparent: true, opacity: 0.35, depthWrite: false });
      const frameM = mats.make(0x3c4146, { roughness: 0.5, metalness: 0.4 }), signM = mats.basic({ color: ACCENT });
      let acc = 0;
      for (const e of G.edges) {
        if (e.cls !== 'arterial' || e.bridge || e.len < 8) continue;
        acc += e.len;
        if (acc < 38) continue;
        acc = 0;
        const A = G.nodes[e.a]!, B = G.nodes[e.b]!, ux = (B.x - A.x) / e.len, uz = (B.z - A.z) / e.len;
        const nx = uz, nz = -ux, off = ROAD_W.arterial / 2 + 0.62; // outward = right side
        const s = new Group();
        s.position.set(A.x + ux * e.len * 0.5 + nx * off, baseY, A.z + uz * e.len * 0.5 + nz * off);
        s.rotation.y = Math.atan2(nz, -nx); // local +x (cos, −sin) points back to the road
        this.clutter.add(s);
        addPart(ctx, s, new BoxGeometry(0.4, 0.04, 1.05).translate(0, 0.8, 0), frameM, { outline: 0 });
        addPart(ctx, s, new BoxGeometry(0.02, 0.62, 0.98).translate(-0.18, 0.46, 0), glass, { outline: 0, cast: false });
        for (const pz of [-0.5, 0.5]) addPart(ctx, s, new BoxGeometry(0.04, 0.8, 0.04).translate(-0.18, 0.4, pz), frameM, { outline: 0 });
        addPart(ctx, s, new BoxGeometry(0.16, 0.05, 0.7).translate(-0.08, 0.2, 0), wood, { outline: 0 });
        addPart(ctx, s, new CylinderGeometry(0.02, 0.02, 1.0, 6).translate(0.1, 0.5, 0.72), frameM, { outline: 0 });
        addPart(ctx, s, new BoxGeometry(0.03, 0.18, 0.18).translate(0.1, 1.0, 0.72), signM, { outline: 0, cast: false });
        s.traverse((o) => { (o as Mesh).raycast = noRaycast; });
      }
    }
  }
}
