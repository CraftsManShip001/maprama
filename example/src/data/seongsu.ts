/**
 * The bundled real-data sample: Seongsu-dong, Seoul, extracted from
 * OpenStreetMap by `tools/osm` (ODbL; the map shows "© OpenStreetMap
 * contributors" through `ui.attribution`). Plus small geo helpers.
 */
import { createProjection, haversineMeters, type LngLat, type WorldData } from '@maprama/protocol';
import seongsuJson from '../../../tools/osm/samples/seongsu.world.json';

export const SEONGSU_WORLD = seongsuJson as unknown as WorldData;

const projection = createProjection({ origin: SEONGSU_WORLD.origin, unitMeters: SEONGSU_WORLD.unitMeters });

/** World units → geographic coordinate. */
export function worldToLngLat(x: number, z: number): LngLat {
  return projection.toLngLat({ x, z });
}

/** Moves a coordinate by meters east / north. */
export function offsetMeters(p: LngLat, eastMeters: number, northMeters: number): LngLat {
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  return { lng: p.lng + eastMeters / (111320 * cosLat), lat: p.lat + northMeters / 110540 };
}

export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
}

export { haversineMeters };

const station = SEONGSU_WORLD.stations[0];
/** Seongsu subway station (the map's landmark). */
export const STATION: LngLat = station ? worldToLngLat(station.x, station.z) : SEONGSU_WORLD.origin;
export const STATION_NAME: string = station?.name ?? 'Seongsu';

/** A few named POIs, for overlays. */
export const NAMED_POIS = SEONGSU_WORLD.pois
  .filter((p) => p.name)
  .slice(0, 12)
  .map((p) => ({ id: p.id, name: p.name, category: p.cat, coordinate: worldToLngLat(p.x, p.z) }));

/** The first named building (used by "pick a sample building" in the buildings screen). */
export const SAMPLE_BUILDING = (() => {
  const b = SEONGSU_WORLD.buildings.find((it) => it.name) ?? SEONGSU_WORLD.buildings[0];
  if (!b) return null;
  const n = b.footprint.length;
  const cx = b.footprint.reduce((a, p) => a + p[0], 0) / n;
  const cz = b.footprint.reduce((a, p) => a + p[1], 0) / n;
  return { id: b.id, name: b.name ?? b.id, coordinate: worldToLngLat(cx, cz) };
})();
