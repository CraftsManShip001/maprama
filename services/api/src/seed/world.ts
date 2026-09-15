import { createProjection, type WorldData } from '@maprama/protocol';
import type { Place, TransitStationInput } from '../deps.js';

/** Converts a `WorldData` file into searchable places (POIs + stations) and transit stations. */
export function seedFromWorld(world: WorldData, region: string): { places: Place[]; stations: TransitStationInput[] } {
  const projection = createProjection({ origin: world.origin, unitMeters: world.unitMeters });
  const toLngLat = (x: number, z: number) => {
    const p = projection.toLngLat({ x, z });
    return { lng: Math.round(p.lng * 1e7) / 1e7, lat: Math.round(p.lat * 1e7) / 1e7 };
  };
  const places: Place[] = world.pois.map((poi) => ({
    id: `poi:${region}:${poi.id}`,
    kind: 'poi',
    name: poi.name,
    address: null,
    category: poi.cat,
    coordinate: toLngLat(poi.x, poi.z),
    source: 'osm',
  }));
  const stations: TransitStationInput[] = world.stations.map((s) => ({
    id: `st:${region}:${s.id}`,
    name: s.name,
    coordinate: toLngLat(s.x, s.z),
  }));
  for (const s of stations) {
    places.push({ id: `station:${s.id.slice(3)}`, kind: 'station', name: s.name, address: null, category: 'subway', coordinate: s.coordinate, source: 'osm' });
  }
  return { places, stations };
}
