import { haversineMeters, type LngLat } from '@diorama/protocol';

/** `[west, south, east, north]` in degrees. */
export type Bbox = [number, number, number, number];

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Encodes a coordinate as a geohash of `precision` characters. */
export function geohashEncode(p: LngLat, precision: number): string {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (p.lng >= mid) {
        ch = (ch << 1) | 1;
        lngLo = mid;
      } else {
        ch <<= 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (p.lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch <<= 1;
        latHi = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Returns the bounds of a geohash cell, or `null` if the hash is invalid. */
export function geohashBounds(hash: string): Bbox | null {
  if (hash.length === 0) return null;
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let even = true;
  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) return null;
    for (let b = 4; b >= 0; b--) {
      const bitOn = (idx >> b) & 1;
      if (even) {
        const mid = (lngLo + lngHi) / 2;
        if (bitOn) lngLo = mid;
        else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (bitOn) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }
  return [lngLo, latLo, lngHi, latHi];
}

/** Cell size in degrees for a geohash precision. */
export function geohashCellSize(precision: number): { dLng: number; dLat: number } {
  const bits = precision * 5;
  const lngBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { dLng: 360 / 2 ** lngBits, dLat: 180 / 2 ** latBits };
}

/** All geohash cells of `precision` intersecting `bbox` (capped at `maxCells`; returns `null` if exceeded). */
export function geohashesInBbox(bbox: Bbox, precision: number, maxCells = 400): string[] | null {
  const { dLng, dLat } = geohashCellSize(precision);
  const [w, s, e, n] = bbox;
  const x0 = Math.floor((w + 180) / dLng);
  const x1 = Math.floor((Math.min(e, 179.9999999) + 180) / dLng);
  const y0 = Math.floor((s + 90) / dLat);
  const y1 = Math.floor((Math.min(n, 89.9999999) + 90) / dLat);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxCells) return null;
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      out.push(geohashEncode({ lng: -180 + (x + 0.5) * dLng, lat: -90 + (y + 0.5) * dLat }, precision));
    }
  }
  return out;
}

/** Bounding box of a circle (approximate, fine for ≤ tens of km). */
export function circleBbox(center: LngLat, radiusMeters: number): Bbox {
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.max(Math.cos((center.lat * Math.PI) / 180), 1e-6));
  return [center.lng - dLng, center.lat - dLat, center.lng + dLng, center.lat + dLat];
}

/** Whether a point lies inside a bbox (inclusive). */
export function bboxContains(b: Bbox, p: LngLat): boolean {
  return p.lng >= b[0] && p.lng <= b[2] && p.lat >= b[1] && p.lat <= b[3];
}

/** Intersection of two bboxes or `null`. */
export function bboxIntersect(a: Bbox, b: Bbox): Bbox | null {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  return w <= e && s <= n ? [w, s, e, n] : null;
}

/** Approximate bbox area in km². */
export function bboxAreaKm2(b: Bbox): number {
  const midLat = (b[1] + b[3]) / 2;
  const wKm = haversineMeters({ lng: b[0], lat: midLat }, { lng: b[2], lat: midLat }) / 1000;
  const hKm = ((b[3] - b[1]) * 111_320) / 1000;
  return wKm * hKm;
}

/** Validates a lng/lat pair. */
export function isLngLat(v: unknown): v is LngLat {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.lng === 'number' &&
    typeof o.lat === 'number' &&
    Number.isFinite(o.lng) &&
    Number.isFinite(o.lat) &&
    o.lng >= -180 &&
    o.lng <= 180 &&
    o.lat >= -90 &&
    o.lat <= 90
  );
}

/** Parses `"lng,lat"`. */
export function parseLngLat(text: string | undefined): LngLat | null {
  if (!text) return null;
  const parts = text.split(',');
  if (parts.length !== 2) return null;
  const p = { lng: Number(parts[0]), lat: Number(parts[1]) };
  return isLngLat(p) ? p : null;
}

/** Parses `"w,s,e,n"`. */
export function parseBbox(text: string | undefined): Bbox | null {
  if (!text) return null;
  const parts = text.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = parts as Bbox;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n) return null;
  return [w, s, e, n];
}

/** Validates a bbox array value. */
export function isBbox(v: unknown): v is Bbox {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    v[0] >= -180 &&
    v[2] <= 180 &&
    v[1] >= -90 &&
    v[3] <= 90 &&
    v[0] < v[2] &&
    v[1] < v[3]
  );
}
