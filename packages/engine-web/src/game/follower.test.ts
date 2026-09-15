import type { TravelMode, WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { loadWorldData } from '../world/data.js';
import {
  Follower,
  normalizeModes,
  pathLength,
  PLANE_MAX_ALTITUDE,
  planeAltitude,
  planLegs,
  SPEED,
  splitByLength,
  type FollowerBody,
  type Leg,
} from './follower.js';

const data: WorldData = {
  version: 1,
  name: 'Legs',
  origin: { lng: 127, lat: 37.5 },
  unitMeters: 8,
  bounds: { minX: -60, minZ: -60, maxX: 60, maxZ: 60 },
  roads: [
    { id: 'main', cls: 'arterial', pts: [[-60, 0], [60, 0]] },
    { id: 'cross', cls: 'local', pts: [[0, -60], [0, 60]] },
    { id: 'north', cls: 'local', pts: [[-60, -30], [60, -30]] },
  ],
  buildings: [],
  water: [],
  parks: [],
  pois: [],
  stations: [{ id: 'w', name: 'West', x: -50, z: 2 }, { id: 'e', name: 'East', x: 50, z: -2 }],
  districts: [],
  attribution: [],
};
const world = loadWorldData(data);
const oneStation = { ...world, stations: world.stations.slice(0, 1) };

const modes = (legs: Leg[]): TravelMode[] => legs.map((l) => l.mode);

class Body implements FollowerBody {
  x = 0; y = 0; z = 0; speed = 0; targetYaw = 0; planePitch = 0; mode: TravelMode = 'walk'; switches: TravelMode[] = [];
  setMode(m: TravelMode): boolean {
    if (m === this.mode) return false;
    this.mode = m;
    this.switches.push(m);
    return true;
  }
}

describe('planLegs', () => {
  it('walk: one leg from the exact start along the roads to the exact end', () => {
    const from = { x: -40, z: 3 }, to = { x: 2, z: 40 };
    const legs = planLegs(world, from, to, ['walk']);
    expect(modes(legs)).toEqual(['walk']);
    const pts = legs[0]!.pts;
    expect(pts[0]).toEqual(from);
    expect(pts[pts.length - 1]).toEqual(to);
    // via the crossing at (0, 0)
    expect(pts.some((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.z) < 1e-6)).toBe(true);
    expect(pathLength(pts)).toBeCloseTo(3 + 40 + 40 + 2, 5);
  });

  it('mixed walk → car → walk: walk to the road, drive, walk off the road', () => {
    const from = { x: -40, z: 3 }, to = { x: 2, z: 40 };
    const legs = planLegs(world, from, to, ['walk', 'car', 'walk']);
    expect(modes(legs)).toEqual(['walk', 'car', 'walk']);
    expect(legs[0]!.pts).toEqual([from, { x: -40, z: 0 }]);
    expect(legs[2]!.pts[legs[2]!.pts.length - 1]).toEqual(to);
    const total = legs.reduce((a, l) => a + pathLength(l.pts), 0);
    expect(total).toBeCloseTo(pathLength(planLegs(world, from, to, ['walk'])[0]!.pts), 5);
    // too short to switch → walk (prototype)
    expect(modes(planLegs(world, { x: 1, z: 0 }, { x: 3, z: 0 }, ['walk', 'car', 'walk']))).toEqual(['walk']);
  });

  it('several road modes share the route by length', () => {
    const legs = planLegs(world, { x: -60, z: 0 }, { x: 60, z: 0 }, ['bike', 'car']);
    expect(modes(legs)).toEqual(['bike', 'car']);
    expect(pathLength(legs[0]!.pts)).toBeCloseTo(60, 5);
    expect(pathLength(legs[1]!.pts)).toBeCloseTo(60, 5);
    const parts = splitByLength([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 20 }], 3);
    expect(parts.map((p) => pathLength(p))).toEqual([10, 10, 10]);
  });

  it('plane: a straight arc; short trips walk', () => {
    const legs = planLegs(world, { x: -40, z: 0 }, { x: 40, z: -30 }, ['plane']);
    expect(legs).toEqual([{ mode: 'plane', pts: [{ x: -40, z: 0 }, { x: 40, z: -30 }] }]);
    expect(modes(planLegs(world, { x: 0, z: 0 }, { x: 5, z: 0 }, ['plane']))).toEqual(['walk']);
    expect(planeAltitude(0, 80)).toBe(0);
    expect(planeAltitude(0.5, 80)).toBeCloseTo(PLANE_MAX_ALTITUDE, 9);
    expect(planeAltitude(0.5, 20)).toBeCloseTo(6, 9);
    expect(planeAltitude(1, 80)).toBeCloseTo(0, 9);
  });

  it('subway: walk to the nearest station, ride to the station nearest the destination, walk on', () => {
    const from = { x: -45, z: 10 }, to = { x: 44, z: -12 };
    const legs = planLegs(world, from, to, ['subway']);
    expect(modes(legs)).toEqual(['walk', 'subway', 'walk']);
    const ride = legs[1]!;
    expect(ride.stations!.map((s) => s.id)).toEqual(['w', 'e']);
    // stations snapped onto the network
    expect(ride.pts).toEqual([{ x: -50, z: 0 }, { x: 50, z: 0 }]);
    expect(legs[0]!.pts[0]).toEqual(from);
    expect(legs[2]!.pts[legs[2]!.pts.length - 1]).toEqual(to);
  });

  it('subway keeps explicit access modes around the ride', () => {
    const legs = planLegs(world, { x: -45, z: 10 }, { x: 44, z: -12 }, ['bike', 'subway', 'car']);
    expect(modes(legs)).toEqual(['bike', 'subway', 'car']);
  });

  it('subway falls back to walking with one station or when both ends share a station', () => {
    expect(modes(planLegs(oneStation, { x: -45, z: 10 }, { x: 44, z: -12 }, ['subway']))).toEqual(['walk']);
    expect(modes(planLegs(world, { x: -45, z: 10 }, { x: -30, z: 10 }, ['subway']))).toEqual(['walk']);
    expect(modes(planLegs({ ...world, stations: [] }, { x: -45, z: 10 }, { x: 44, z: -12 }, ['walk', 'subway', 'walk']))).toEqual(['walk']);
  });

  it('normalizes the mode chain and returns no legs for a trip to the start', () => {
    expect(normalizeModes([])).toEqual(['walk']);
    expect(normalizeModes(['walk', 'walk', 'car', 'car', 'walk'])).toEqual(['walk', 'car', 'walk']);
    expect(planLegs(world, { x: 3, z: 0 }, { x: 3, z: 0 }, ['car'])).toEqual([]);
  });
});

describe('Follower', () => {
  it('follows legs, waits for vehicle pop-in, reports remaining distance and arrives once', () => {
    const body = new Body();
    body.x = -40; body.z = 3;
    const f = new Follower(body, 0.09);
    const legs = planLegs(world, { x: -40, z: 3 }, { x: 2, z: 40 }, ['walk', 'car', 'walk']);
    let arrived = 0;
    f.onArrive = () => { arrived++; };
    f.setTrip(legs);
    const total = legs.reduce((a, l) => a + pathLength(l.pts), 0);
    expect(f.remainingByLeg().reduce((a, r) => a + r.d, 0)).toBeCloseTo(total, 5);
    let prev = Infinity;
    for (let i = 0; i < 2000 && f.active; i++) {
      f.step(0.05);
      const rem = f.remainingByLeg().reduce((a, r) => a + r.d, 0);
      expect(rem).toBeLessThanOrEqual(prev + 1e-9);
      prev = rem;
    }
    expect(arrived).toBe(1);
    expect(f.active).toBe(false);
    expect(body.x).toBeCloseTo(2, 9);
    expect(body.z).toBeCloseTo(40, 9);
    expect(body.switches).toEqual(['car', 'walk']);
    f.step(0.05);
    expect(arrived).toBe(1);
  });

  it('lifts a plane along its arc (mid-flight altitude and nose pitch)', () => {
    const body = new Body();
    body.x = -40;
    const f = new Follower(body, 0.09);
    f.setTrip(planLegs(world, { x: -40, z: 0 }, { x: 40, z: 0 }, ['plane']));
    expect(f.wait).toBeGreaterThan(0);
    for (let i = 0; i < 40 && f.wait > 0; i++) f.step(0.05);
    // fly to the middle
    let guard = 0;
    while (body.x < 0 && guard++ < 1000) f.step(0.01);
    expect(body.x).toBeGreaterThanOrEqual(0);
    expect(body.x).toBeLessThan(SPEED.plane * 0.01 + 1e-9);
    expect(body.y).toBeGreaterThan(0.09 + PLANE_MAX_ALTITUDE - 0.1);
    expect(Math.abs(body.planePitch)).toBeLessThan(0.02);
  });
});
