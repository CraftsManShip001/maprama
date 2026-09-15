/**
 * Shared building-attribute rules used by every world source (prototype
 * height → roof/kind rules and the massing variety seed).
 *
 * @module
 */

import type { BuildingKind } from '@maprama/protocol';
import { mulberry32 } from '../util/math.js';
import type { MassShape, RoofKind } from './model.js';

/** Massing variety for a rectangular lot (uses its own seed, like the prototype). */
export function autoShapeFor(idx: number, h: number, w: number, d: number, infill = false): MassShape {
  const sr = mulberry32(idx * 131 + 17)();
  const minWD = Math.min(w, d), maxWD = Math.max(w, d);
  if (infill) {
    if (h > 3.0 && minWD > 2.8 && sr < 0.5) return 'setback';
    if (minWD > 2.8 && sr < 0.75) return 'L';
    return 'box';
  }
  if (h > 5.4 && maxWD > 3.0 && sr < 0.35) return 'twin';
  if (h > 3.6 && minWD > 2.6 && sr < 0.62) return 'podium';
  if (h > 3.0 && minWD > 2.8 && sr < 0.82) return 'setback';
  if (h <= 4.6 && minWD > 2.8 && sr < 0.92) return 'L';
  return 'box';
}

/** Prototype roof rule. */
export function roofFor(h: number, q: number, minWD: number): RoofKind {
  return h > 4.6 ? 'flat' : q < 0.52 ? 'flat' : q < 0.84 || minWD < 2.2 ? 'gable' : 'dome';
}

/** Prototype facade-kind rule; `r` supplies extra random draws. */
export function kindFor(h: number, roof: RoofKind, r: () => number): BuildingKind {
  return h > 5.0 ? 'glass' : h > 3.2 ? (r() < 0.55 ? 'apartment' : 'office') : roof === 'gable' ? 'brick' : r() < 0.5 ? 'brick' : 'office';
}
