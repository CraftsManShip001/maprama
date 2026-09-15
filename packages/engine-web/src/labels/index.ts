/**
 * Label index (stable ids reported with `labelsIndex`), content resolution
 * for the label content modes, and the pure placement rules shared by the
 * DOM and holo label styles (visibility per kind, collision boxes, HUD
 * exclusion zones). No three.js, no DOM.
 *
 * Label ids are derived from source data only, so rebuilding the same world
 * yields the same ids:
 * - POIs: `poi:<poi id>`
 * - districts: `district:<name>` (`#2`, `#3`… for repeated names, in data order)
 * - roads: `road:<road id>:<sample index>`; anchors are sampled every 42 units
 *   from 16 units along each named, non-alley, non-bridge road, skipping
 *   anchors within 30 units of an earlier anchor of the same name.
 *
 * @module
 */

import type {
  LabelContent,
  LabelContentMode,
  LabelIcon,
  LabelInfo,
  LabelKind,
  MapUiSpec,
  PoiCategory,
  Projection,
  RoadClass,
} from '@maprama/protocol';
import type { WorldModel } from '../world/model.js';
import { KIND_SUBTITLES, POI_SUBTITLES } from './icons.js';

/** A label with the engine-side placement data. */
export interface LabelEntry extends LabelInfo {
  /** Anchor in world units. */
  x: number;
  z: number;
  /** Draw priority (lower first): district 0, arterial road 1, POI 2, other road 3. */
  pri: number;
  /** Default icon. */
  icon: LabelIcon;
  roadClass?: RoadClass;
  /** Road tangent (unit vector) at the anchor. */
  tx?: number;
  tz?: number;
  water?: boolean;
}

const ROAD_START = 16, ROAD_STEP = 42, ROAD_END_MARGIN = 8, ROAD_DEDUPE = 30;

/** Builds the label entries of a world. */
export function buildLabelEntries(world: WorldModel, proj: Projection): LabelEntry[] {
  const out: LabelEntry[] = [];
  const b = world.bounds;
  const inBounds = (x: number, z: number): boolean => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  const seen = new Map<string, number>();
  for (const d of world.districts) {
    const n = (seen.get(d.name) ?? 0) + 1;
    seen.set(d.name, n);
    const water = !!d.water;
    const e: LabelEntry = {
      id: `district:${d.name}${n > 1 ? `#${n}` : ''}`, kind: 'district', name: d.name,
      subtitle: water ? KIND_SUBTITLES.water : KIND_SUBTITLES.district,
      lngLat: proj.toLngLat({ x: d.x, z: d.z }), x: d.x, z: d.z, pri: 0, icon: water ? 'water' : 'district',
    };
    if (water) e.water = true;
    out.push(e);
  }
  const anchors: { name: string; x: number; z: number }[] = [];
  for (const r of world.graph.roads) {
    if (r.cls === 'alley' || r.bridge || !r.name) continue;
    const pts = r.pts;
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
    for (let k = 0, s = ROAD_START; s < L - ROAD_END_MARGIN; k++, s += ROAD_STEP) {
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i]!, [bx, bz] = pts[i + 1]!;
        const seg = Math.hypot(bx - ax, bz - az);
        if (seg > 0 && acc + seg >= s) {
          const t = (s - acc) / seg, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          if (inBounds(x, z) && !anchors.some((a) => a.name === r.name && Math.hypot(a.x - x, a.z - z) < ROAD_DEDUPE)) {
            anchors.push({ name: r.name, x, z });
            const art = r.cls === 'arterial';
            out.push({
              id: `road:${r.id}:${k}`, kind: 'road', name: r.name, subtitle: art ? KIND_SUBTITLES.avenue : KIND_SUBTITLES.street,
              lngLat: proj.toLngLat({ x, z }), x, z, pri: art ? 1 : 3, icon: art ? 'avenue' : 'street',
              roadClass: r.cls, tx: (bx - ax) / seg, tz: (bz - az) / seg,
            });
          }
          break;
        }
        acc += seg;
      }
    }
  }
  for (const p of world.pois) {
    out.push({
      id: `poi:${p.id}`, kind: 'poi', name: p.name, category: p.cat, subtitle: POI_SUBTITLES[p.cat],
      lngLat: proj.toLngLat({ x: p.x, z: p.z }), x: p.x, z: p.z, pri: 2, icon: p.cat,
    });
  }
  return out;
}

/** Protocol view of an entry (for `labelsIndex`). */
export function toLabelInfo(e: LabelEntry): LabelInfo {
  const info: LabelInfo = { id: e.id, kind: e.kind, name: e.name, lngLat: { ...e.lngLat } };
  if (e.category) info.category = e.category;
  if (e.subtitle !== undefined) info.subtitle = e.subtitle;
  return info;
}

/** What a label displays after applying the content mode. */
export interface ResolvedLabelContent {
  title: string;
  subtitle: string;
  icon: LabelIcon;
  showIcon: boolean;
  showSubtitle: boolean;
  /** Host-supplied content was applied. */
  custom: boolean;
}

/**
 * Applies a content mode: `nameAndType` (name, subtitle, icon), `nameOnly`
 * (name, icon), `textOnly` (name), `custom` (the host entry's title /
 * subtitle / icon; labels without an entry fall back to `nameAndType`).
 */
export function resolveLabelContent(entry: LabelEntry, mode: LabelContentMode = 'nameAndType', entries: Readonly<Record<string, LabelContent>> = {}): ResolvedLabelContent {
  const base: ResolvedLabelContent = { title: entry.name, subtitle: entry.subtitle ?? '', icon: entry.icon, showIcon: true, showSubtitle: true, custom: false };
  switch (mode) {
    case 'nameOnly':
      return { ...base, showSubtitle: false };
    case 'textOnly':
      return { ...base, showIcon: false, showSubtitle: false };
    case 'custom': {
      const c = Object.prototype.hasOwnProperty.call(entries, entry.id) ? entries[entry.id] : undefined;
      if (!c) return base;
      return { title: c.title, subtitle: c.subtitle ?? '', icon: c.icon ?? entry.icon, showIcon: true, showSubtitle: !!c.subtitle, custom: true };
    }
    default:
      return base;
  }
}

/** A screen-space box: center and half extents in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  hw: number;
  hh: number;
}

export const overlaps = (a: Box, b: Box): boolean => Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh;

/**
 * Screen regions labels must not cover: the status bar strip, the engine's
 * map UI (zoom buttons, scale bar, attribution) and a bottom margin. The
 * game HUD is drawn by the host, which reserves space with the same idea.
 */
export function hudExclusions(vw: number, vh: number, ui: MapUiSpec = {}, insets: { top?: number; bottom?: number } = {}): Box[] {
  const top = insets.top ?? 0, bottom = insets.bottom ?? 0;
  const boxes: Box[] = [
    { x: vw / 2, y: top / 2 + 14, hw: vw / 2, hh: top / 2 + 22 },
    { x: vw / 2, y: vh - bottom / 2 - 6, hw: vw / 2, hh: bottom / 2 + 14 },
  ];
  if (ui.zoomButtons) boxes.push({ x: vw - 36, y: top + 56 + 48, hw: 36, hh: 56 });
  if (ui.scaleBar) boxes.push({ x: 70, y: vh - bottom - 30, hw: 70, hh: 18 });
  if (ui.attribution) boxes.push({ x: vw - 90, y: vh - bottom - 24, hw: 90, hh: 14 });
  return boxes;
}

/** Holo label height above the ground in world units per kind (prototype `H`). */
export const HOLO_HEIGHT: Readonly<Record<LabelKind, number>> = Object.freeze({ district: 7, poi: 3.6, road: 2.8 });

/** Maximum road holo labels on screen (prototype). */
export const HOLO_MAX_ROADS = 5;

/** Whether a holo label is a candidate at camera distance `dist` and target distance `dT` (world units). */
export function holoEligible(kind: LabelKind, dT: number, dist: number): boolean {
  if (kind === 'district') return dist > 40;
  if (kind === 'poi') return dT < 24 + dist * 0.4;
  return dT < 14 + dist * 0.35 && dist < 120;
}

/** A projected holo candidate. */
export interface HoloCandidate {
  id: string;
  kind: LabelKind;
  pri: number;
  /** Distance to the camera target (world units). */
  dT: number;
  eligible: boolean;
  /** Panel anchor (top of the leader line) and whether it is on screen. */
  top: { x: number; y: number };
  onScreen: boolean;
  /** Card size in CSS pixels. */
  w: number;
  h: number;
}

/**
 * Greedy holo placement (prototype `updateHoloLabels`): candidates sorted by
 * priority then target distance; a card is shown when eligible, on screen, not
 * over an exclusion zone or an earlier card, and within the road budget.
 * Returns the shown ids with their boxes, in placement order.
 */
export function placeHolo(candidates: readonly HoloCandidate[], exclusions: readonly Box[], maxRoads = HOLO_MAX_ROADS): Map<string, Box> {
  const placed: Box[] = [...exclusions];
  const shown = new Map<string, Box>();
  let roads = 0;
  const sorted = [...candidates].sort((a, b) => a.pri - b.pri || a.dT - b.dT);
  for (const c of sorted) {
    if (!c.eligible || !c.onScreen || (c.kind === 'road' && roads >= maxRoads)) continue;
    const box: Box = { x: c.top.x, y: c.top.y - c.h / 2 - 2, hw: c.w / 2 + 5, hh: c.h / 2 + 4 };
    if (placed.some((p) => overlaps(p, box))) continue;
    placed.push(box);
    shown.set(c.id, box);
    if (c.kind === 'road') roads++;
  }
  return shown;
}

/** DOM label styles. */
export type DomLabelStyle = 'app' | 'minimal' | 'clean' | 'sticker';

/** Visibility of a DOM-style label by kind and camera distance (prototype `updateMapLabels`). */
export function domLabelVisible(style: DomLabelStyle, e: Pick<LabelEntry, 'kind' | 'pri'>, dist: number, zoomOut: number): boolean {
  let show = e.kind === 'district' ? dist > 42 || zoomOut > 0.2 : e.kind === 'road' ? dist > 22 && (e.pri === 1 || dist < 115) : dist < 125;
  if (style === 'minimal' && (e.pri === 3 || (e.kind === 'poi' && dist > 70))) show = false;
  if (style === 'clean' && ((e.pri === 3 && dist > 80) || (e.kind === 'poi' && dist > 95))) show = false;
  return show;
}

/** Gap (CSS px) kept between a label box and the left / right viewport edge. */
export const LABEL_EDGE_MARGIN = 6;

/**
 * Horizontal center for a label box of half width `hw` wanted at `x`, moved
 * so the box stays inside `[margin, vw − margin]` (a box wider than that is
 * centered in the viewport).
 */
export function clampLabelX(x: number, hw: number, vw: number, margin = LABEL_EDGE_MARGIN): number {
  const lo = margin + hw, hi = vw - margin - hw;
  return lo > hi ? vw / 2 : Math.min(hi, Math.max(lo, x));
}

/** Collision box of a rotated DOM label of size `w`×`h` at `(x, y)` (prototype padding). */
export function rotatedBox(x: number, y: number, w: number, h: number, angle: number): Box {
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  return { x, y, hw: (c * w + s * h) / 2 + 4, hh: (s * w + c * h) / 2 + 3 };
}

/** Keeps road label text upright: folds a screen angle into (−π/2, π/2]. */
export function uprightAngle(a: number): number {
  let r = a;
  if (r > Math.PI / 2) r -= Math.PI;
  if (r < -Math.PI / 2) r += Math.PI;
  return r;
}

/** Icon tile treatment after resolving `auto` (white by day, black at night). */
export function iconTileFor(tile: 'auto' | 'white' | 'black' | 'color' | undefined, night: boolean): 'white' | 'black' | 'color' {
  const t = tile ?? 'auto';
  return t === 'auto' ? (night ? 'black' : 'white') : t;
}

/** Stable POI category lookup helper for renderers. */
export function categoryOf(e: LabelEntry): PoiCategory | undefined {
  return e.category;
}
