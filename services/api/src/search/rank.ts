import { haversineMeters, type LngLat } from '@maprama/protocol';
import { SEARCH_LIMITS } from '../config.js';
import type { Place } from '../deps.js';
import { textScore } from './normalize.js';

export interface RankedPlace extends Place {
  score: number;
  textScore: number;
  distanceMeters?: number;
}

/**
 * Ranks candidates: text score alone, or blended with proximity when `near` is given:
 * `score = (1 - w) * text + w * 1 / (1 + distance / 1000 m)`, `w = 0.3`.
 */
export function rankPlaces(candidates: Place[], queryNorm: string, near?: LngLat): RankedPlace[] {
  const w = SEARCH_LIMITS.proximityWeight;
  const ranked: RankedPlace[] = [];
  const seen = new Set<string>();
  for (const p of candidates) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const text = textScore(queryNorm, p.name, p.address);
    if (text <= 0) continue;
    if (near) {
      const d = haversineMeters(near, p.coordinate);
      const proximity = 1 / (1 + d / SEARCH_LIMITS.proximityHalfMeters);
      ranked.push({ ...p, textScore: text, distanceMeters: Math.round(d), score: (1 - w) * text + w * proximity });
    } else {
      ranked.push({ ...p, textScore: text, score: text });
    }
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0) ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ranked;
}
