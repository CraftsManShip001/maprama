import type { WorldData } from '../index.js';

/** A small valid WorldData used by tests. */
export function sampleWorld(): WorldData {
  return {
    version: 1,
    name: 'Test Town',
    origin: { lng: 126.978, lat: 37.5665 },
    unitMeters: 8,
    bounds: { minX: -50, minZ: -50, maxX: 50, maxZ: 50 },
    roads: [
      { id: 'r1', name: 'Main St', cls: 'arterial', pts: [[-50, 0], [50, 0]] },
      { id: 'r2', cls: 'alley', bridge: true, pts: [[0, -50], [0, 50]] },
    ],
    buildings: [
      { id: 'b1', footprint: [[1, 1], [5, 1], [5, 5], [1, 5]], height: 4, levels: 10, kind: 'glass', name: 'Tower' },
      { id: 'b2', footprint: [[-5, -5], [-1, -5], [-3, -1]], height: 1.5 },
    ],
    water: [[[10, 10], [20, 10], [20, 20]]],
    parks: [{ name: 'Green', poly: [[-20, -20], [-10, -20], [-10, -10]] }, { poly: [[0, 0], [1, 0], [0, 1]] }],
    pois: [{ id: 'p1', name: 'Cafe', cat: 'cafe', x: 3, z: -4 }],
    stations: [{ id: 's1', name: 'City Hall', x: -8, z: 8 }],
    districts: [{ name: 'Jung-gu', x: 0, z: 0 }, { name: 'Han River', x: 40, z: 40, water: true }],
    plaza: { x: 0, z: 0 },
    attribution: ['© OpenStreetMap contributors'],
  };
}
