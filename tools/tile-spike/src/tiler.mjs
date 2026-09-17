/**
 * `WorldData` -> MTIL tiles.
 *
 * Ownership rules (see docs/design/tile-format.md §3):
 *   - buildings, POIs, stations, districts: owned by the tile containing the
 *     feature's anchor (footprint centroid / the point). Geometry is stored
 *     whole and is never cut, so a building never seams and never appears twice.
 *   - roads, water, parks: clipped to the tile plus a buffer, because a single
 *     feature (한강, a national road) can span the whole country.
 */

import { fromTileLocal, lngLatToMercator, mercatorToLngLat, toTileLocal, worldToLngLat } from './mercator.mjs';
import { encodeTile } from './payload.mjs';

/** Converts a `WorldData` document to lng/lat features, keeping ids and tags. */
export function worldToGeo(world) {
  const { origin, unitMeters } = world;
  const pt = (x, z) => worldToLngLat(origin, unitMeters, x, z);
  const line = (pts) => pts.map(([x, z]) => pt(x, z));
  return {
    roads: world.roads.map((r) => ({ id: r.id, cls: r.cls, ...(r.name !== undefined ? { name: r.name } : {}), ...(r.bridge ? { bridge: true } : {}), pts: line(r.pts) })),
    buildings: world.buildings.map((b) => ({
      id: b.id,
      heightDm: Math.max(0, Math.round(b.height * unitMeters * 10)),
      ...(b.levels !== undefined ? { levels: b.levels } : {}),
      ...(b.kind !== undefined ? { kind: b.kind } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      footprint: line(b.footprint),
    })),
    water: world.water.map((poly) => ({ poly: line(poly) })),
    parks: world.parks.map((p) => ({ ...(p.name !== undefined ? { name: p.name } : {}), poly: line(p.poly) })),
    pois: world.pois.map((p) => ({ ...p, ...pt(p.x, p.z) })),
    stations: world.stations.map((s) => ({ ...s, ...pt(s.x, s.z) })),
    districts: world.districts.map((d) => ({ ...d, ...pt(d.x, d.z) })),
  };
}

const lngLatBbox = (pts) => {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const p of pts) {
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return { west, east, south, north };
};

/** Tile range (inclusive) covering a lng/lat bbox at zoom `z`. */
function tileRange(bbox, z) {
  const n = 2 ** z;
  const nw = lngLatToMercator(bbox.west, bbox.north);
  const se = lngLatToMercator(bbox.east, bbox.south);
  return {
    x0: Math.max(0, Math.floor(nw.mx * n)),
    x1: Math.min(n - 1, Math.floor(se.mx * n)),
    y0: Math.max(0, Math.floor(nw.my * n)),
    y1: Math.min(n - 1, Math.floor(se.my * n)),
  };
}

/**
 * Anchor point of a footprint: its area-weighted centroid, falling back to the
 * bounding-box centre when the ring is degenerate (collinear or near-zero area).
 * The fallback matters — a thin sliver's shoelace area is tiny but non-zero, and
 * dividing by it throws the anchor hundreds of metres away, which would file the
 * building under a tile it is nowhere near.
 */
export function ringAnchor(ring) {
  const bbox = lngLatBbox(ring);
  const mid = { lng: (bbox.west + bbox.east) / 2, lat: (bbox.south + bbox.north) / 2 };
  let a = 0, cx = 0, cy = 0;
  // shift to the bbox centre first so the cross products keep their precision
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const px = ring[j].lng - mid.lng, py = ring[j].lat - mid.lat;
    const qx = ring[i].lng - mid.lng, qy = ring[i].lat - mid.lat;
    const cross = px * qy - qx * py;
    a += cross;
    cx += (px + qx) * cross;
    cy += (py + qy) * cross;
  }
  const bboxArea = (bbox.east - bbox.west) * (bbox.north - bbox.south);
  if (bboxArea <= 0 || Math.abs(a / 2) < 0.02 * bboxArea) return mid;
  const c = { lng: mid.lng + cx / (3 * a), lat: mid.lat + cy / (3 * a) };
  const inBox = c.lng >= bbox.west && c.lng <= bbox.east && c.lat >= bbox.south && c.lat <= bbox.north;
  return inBox ? c : mid;
}

/** Ground area of a lng/lat ring, m² (equirectangular, fine at this scale). */
function ringAreaM2(ring) {
  const bbox = lngLatBbox(ring);
  const midLat = (bbox.north + bbox.south) / 2;
  const kx = 111320 * Math.cos((midLat * Math.PI) / 180), ky = 110540;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j].lng * kx) * (ring[i].lat * ky) - (ring[i].lng * kx) * (ring[j].lat * ky);
  }
  return Math.abs(a / 2);
}

/**
 * The overview profile: what a zoomed-out 2D level keeps. Small buildings,
 * alleys, local streets and POIs are invisible at that scale and are what makes
 * a low-zoom tile huge, so they are dropped rather than simplified.
 */
export function filterForOverview(geo, { minBuildingHeightM = 30, minBuildingAreaM2 = 1500, minParkAreaM2 = 5000 } = {}) {
  return {
    roads: geo.roads.filter((r) => r.cls === 'arterial'),
    buildings: geo.buildings.filter((b) => b.heightDm >= minBuildingHeightM * 10 || ringAreaM2(b.footprint) >= minBuildingAreaM2),
    water: geo.water,
    parks: geo.parks.filter((p) => ringAreaM2(p.poly) >= minParkAreaM2),
    pois: [],
    stations: geo.stations,
    districts: geo.districts,
  };
}

/* ----------------------------------------------------------- clipping */

const inside = (p, edge, r) =>
  edge === 0 ? p[0] >= r.min : edge === 1 ? p[0] <= r.max : edge === 2 ? p[1] >= r.min : p[1] <= r.max;

function intersect(a, b, edge, r) {
  const value = edge === 0 || edge === 2 ? r.min : r.max;
  if (edge < 2) {
    const t = (value - a[0]) / (b[0] - a[0]);
    return [value, a[1] + t * (b[1] - a[1])];
  }
  const t = (value - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), value];
}

/** Sutherland–Hodgman against the square `[r.min, r.max]²`. */
export function clipPolygon(ring, r) {
  let out = ring;
  for (let edge = 0; edge < 4 && out.length > 0; edge++) {
    const input = out;
    out = [];
    for (let i = 0, j = input.length - 1; i < input.length; j = i++) {
      const cur = input[i], prev = input[j];
      const curIn = inside(cur, edge, r), prevIn = inside(prev, edge, r);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur, edge, r));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur, edge, r));
      }
    }
  }
  // drop duplicate consecutive vertices introduced by the clip
  const cleaned = [];
  for (const p of out) {
    const last = cleaned[cleaned.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) cleaned.push(p);
  }
  if (cleaned.length > 1) {
    const f = cleaned[0], l = cleaned[cleaned.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) cleaned.pop();
  }
  return cleaned.length >= 3 ? cleaned : null;
}

/** Liang–Barsky per segment; returns the polyline parts inside the square. */
export function clipPolyline(pts, r) {
  const parts = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = clipSegment(pts[i], pts[i + 1], r);
    if (!seg) { cur = null; continue; }
    const [a, b] = seg;
    if (cur && cur[cur.length - 1][0] === a[0] && cur[cur.length - 1][1] === a[1]) {
      cur.push(b);
    } else {
      cur = [a, b];
      parts.push(cur);
    }
  }
  return parts.filter((p) => p.length >= 2);
}

function clipSegment(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const tests = [[-dx, a[0] - r.min], [dx, r.max - a[0]], [-dy, a[1] - r.min], [dy, r.max - a[1]]];
  for (const [p, q] of tests) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  const at = [Math.round(a[0] + t0 * dx), Math.round(a[1] + t0 * dy)];
  const bt = [Math.round(a[0] + t1 * dx), Math.round(a[1] + t1 * dy)];
  return at[0] === bt[0] && at[1] === bt[1] ? null : [at, bt];
}

/** Removes vertices that repeat after quantisation. */
function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/* ----------------------------------------------------------- tiling */

/**
 * Splits geo features into tiles at one zoom level.
 *
 * @returns Map keyed `z/x/y` -> `{ z, x, y, layers, stats }`
 */
export function tileFeatures(geo, z, { extent, buffer }) {
  const tiles = new Map();
  const rect = { min: -buffer, max: extent + buffer };
  const get = (x, y) => {
    const key = `${z}/${x}/${y}`;
    let t = tiles.get(key);
    if (!t) {
      t = { z, x, y, key, layers: { roads: [], buildings: [], water: [], parks: [], pois: [], stations: [], districts: [] } };
      tiles.set(key, t);
    }
    return t;
  };
  const local = (p, x, y) => {
    const { u, v } = toTileLocal(p.lng, p.lat, z, x, y, extent);
    return [u, v];
  };
  const stats = { buildingOverflowUnits: 0, clippedParts: 0, wholeFeatures: 0 };

  // anchor-owned layers: whole geometry, exactly one tile
  for (const b of geo.buildings) {
    const c = ringAnchor(b.footprint);
    const n = 2 ** z;
    const m = lngLatToMercator(c.lng, c.lat);
    const x = Math.min(n - 1, Math.floor(m.mx * n)), y = Math.min(n - 1, Math.floor(m.my * n));
    const ring = dedupe(b.footprint.map((p) => local(p, x, y)));
    if (ring.length < 3) continue;
    for (const [u, v] of ring) {
      stats.buildingOverflowUnits = Math.max(stats.buildingOverflowUnits, -u, -v, u - extent, v - extent);
    }
    get(x, y).layers.buildings.push({ ...b, footprint: ring });
    stats.wholeFeatures++;
  }
  for (const [layerName, items] of [['pois', geo.pois], ['stations', geo.stations], ['districts', geo.districts]]) {
    for (const p of items) {
      const n = 2 ** z;
      const m = lngLatToMercator(p.lng, p.lat);
      const x = Math.min(n - 1, Math.floor(m.mx * n)), y = Math.min(n - 1, Math.floor(m.my * n));
      const [u, v] = local(p, x, y);
      get(x, y).layers[layerName].push({ ...p, u, v });
      stats.wholeFeatures++;
    }
  }

  // clipped layers
  for (const road of geo.roads) {
    const range = tileRange(lngLatBbox(road.pts), z);
    for (let x = range.x0; x <= range.x1; x++) {
      for (let y = range.y0; y <= range.y1; y++) {
        const pts = dedupe(road.pts.map((p) => local(p, x, y)));
        if (pts.length < 2) continue;
        const parts = clipPolyline(pts, rect);
        parts.forEach((part, i) => {
          get(x, y).layers.roads.push({ ...road, id: parts.length > 1 ? `${road.id}#${i}` : road.id, pts: part });
          stats.clippedParts++;
        });
      }
    }
  }
  for (const [layerName, items] of [['water', geo.water], ['parks', geo.parks]]) {
    for (const f of items) {
      const range = tileRange(lngLatBbox(f.poly), z);
      for (let x = range.x0; x <= range.x1; x++) {
        for (let y = range.y0; y <= range.y1; y++) {
          const ring = dedupe(f.poly.map((p) => local(p, x, y)));
          if (ring.length < 3) continue;
          const clipped = clipPolygon(ring, rect);
          if (!clipped) continue;
          get(x, y).layers[layerName].push({ ...f, poly: clipped });
          stats.clippedParts++;
        }
      }
    }
  }

  for (const [key, t] of tiles) {
    const empty = Object.values(t.layers).every((l) => l.length === 0);
    if (empty) tiles.delete(key);
  }
  return { tiles, stats };
}

/** Encodes every tile of a {@link tileFeatures} result. */
export function encodeTiles(tiles, { extent, buffer, attribution }) {
  const out = new Map();
  for (const [key, t] of tiles) out.set(key, { ...t, bytes: encodeTile({ extent, buffer, attribution, layers: t.layers }) });
  return out;
}

export { fromTileLocal, mercatorToLngLat };
