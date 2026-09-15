import { describe, expect, it } from 'vitest';
import {
  classifyKind,
  classifyPoi,
  classifyRoad,
  displayName,
  heuristicHeightMeters,
  isBridge,
  parseMeters,
  resolveHeight,
} from '../src/classify.js';

describe('classifyRoad', () => {
  it.each([
    ['motorway', 'arterial'],
    ['trunk', 'arterial'],
    ['primary', 'arterial'],
    ['secondary', 'arterial'],
    ['tertiary', 'local'],
    ['residential', 'local'],
    ['unclassified', 'local'],
    ['living_street', 'local'],
    ['footway', 'alley'],
    ['path', 'alley'],
    ['pedestrian', 'alley'],
    ['service', 'alley'],
    ['track', 'alley'],
    ['steps', 'alley'],
    ['construction', null],
    ['proposed', null],
    ['platform', null],
  ])('highway=%s -> %s', (highway, cls) => {
    expect(classifyRoad({ highway })).toBe(cls);
  });

  it('named service roads are local', () => {
    expect(classifyRoad({ highway: 'service', name: '뚝섬로1길' })).toBe('local');
  });

  it('skips sidewalks unless requested, and pedestrian areas', () => {
    expect(classifyRoad({ highway: 'footway', footway: 'sidewalk' })).toBeNull();
    expect(classifyRoad({ highway: 'footway', footway: 'sidewalk' }, { includeSidewalks: true })).toBe('alley');
    expect(classifyRoad({ highway: 'pedestrian', area: 'yes' })).toBeNull();
  });

  it('bridge and name helpers', () => {
    expect(isBridge({ bridge: 'yes' })).toBe(true);
    expect(isBridge({ bridge: 'viaduct' })).toBe(true);
    expect(isBridge({ bridge: 'no' })).toBe(false);
    expect(displayName({ name: 'Seongsuiro', 'name:ko': '성수이로' })).toBe('성수이로');
    expect(displayName({ name: '연무장길' })).toBe('연무장길');
    expect(displayName({})).toBeUndefined();
  });
});

describe('heights', () => {
  it('parses OSM length values', () => {
    expect(parseMeters('12')).toBe(12);
    expect(parseMeters('12.5 m')).toBe(12.5);
    expect(parseMeters('12m')).toBe(12);
    expect(parseMeters('100 ft')).toBeCloseTo(30.48);
    expect(parseMeters("10'6\"")).toBeCloseTo(3.2004);
    expect(parseMeters('20;25')).toBe(20);
    expect(parseMeters('tall')).toBeUndefined();
    expect(parseMeters('0')).toBeUndefined();
  });

  it('heuristics by building tag', () => {
    expect(heuristicHeightMeters('apartments')).toBe(45);
    expect(heuristicHeightMeters('commercial')).toBe(30);
    expect(heuristicHeightMeters('office')).toBe(30);
    expect(heuristicHeightMeters('house')).toBe(9);
    expect(heuristicHeightMeters('residential')).toBe(9);
    expect(heuristicHeightMeters('retail')).toBe(7);
    expect(heuristicHeightMeters('yes')).toBe(12);
    expect(heuristicHeightMeters(undefined)).toBe(12);
  });

  it('precedence: external height > external levels > height tag > levels tag > heuristic', () => {
    const tags = { building: 'apartments', height: '40', 'building:levels': '10' };
    expect(resolveHeight(tags, { heightMeters: 62, levels: 20 })).toEqual({ heightMeters: 62, levels: 20, source: 'kr-height' });
    const krLevels = resolveHeight(tags, { levels: 3 });
    expect(krLevels).toMatchObject({ levels: 3, source: 'kr-levels' });
    expect(krLevels.heightMeters).toBeCloseTo(9.6);
    expect(resolveHeight(tags)).toEqual({ heightMeters: 40, levels: 10, source: 'height' });
    expect(resolveHeight({ building: 'yes', 'building:levels': '5' })).toMatchObject({ heightMeters: 16, levels: 5, source: 'levels' });
    expect(resolveHeight({ building: 'apartments' })).toEqual({ heightMeters: 45, source: 'heuristic' });
  });
});

describe('classifyKind', () => {
  it('assigns facade kinds', () => {
    expect(classifyKind({ building: 'yes' }, 75)).toBe('glass');
    expect(classifyKind({ building: 'yes', 'building:material': 'glass' }, 10)).toBe('glass');
    expect(classifyKind({ building: 'apartments' }, 45)).toBe('apartment');
    expect(classifyKind({ building: 'apartments', start_date: '1978' }, 15)).toBe('brick');
    expect(classifyKind({ building: 'commercial' }, 16)).toBe('office');
    expect(classifyKind({ building: 'office' }, 30)).toBe('office');
    expect(classifyKind({ building: 'house' }, 9)).toBe('brick');
    expect(classifyKind({ building: 'retail' }, 7)).toBe('brick');
    expect(classifyKind({ building: 'yes' }, 12)).toBe('brick');
    expect(classifyKind({ building: 'yes' }, 25)).toBe('office');
  });
});

describe('classifyPoi', () => {
  it.each([
    [{ amenity: 'cafe', name: 'A' }, 'cafe'],
    [{ shop: 'convenience', name: 'A' }, 'store'],
    [{ shop: 'supermarket', name: 'A' }, 'store'],
    [{ shop: 'music', name: 'A' }, 'music'],
    [{ amenity: 'cafe', name: 'LP카페' }, 'music'],
    [{ shop: 'clothes', name: '성수 레코드' }, 'music'],
    [{ shop: 'gift', name: '음반가게' }, 'music'],
    [{ shop: 'clothes', name: 'HELP store' }, null],
    [{ amenity: 'school', name: 'A' }, 'school'],
    [{ amenity: 'kindergarten', name: 'A' }, 'school'],
    [{ shop: 'books', name: 'A' }, 'book'],
    [{ leisure: 'park', name: 'A' }, 'park'],
    [{ railway: 'station', name: 'A' }, 'subway'],
    [{ station: 'subway', name: 'A' }, 'subway'],
    [{ place: 'square', name: 'A' }, 'plaza'],
    [{ amenity: 'bank', name: 'A' }, null],
  ] as const)('%o -> %s', (tags, cat) => {
    expect(classifyPoi(tags)).toBe(cat);
  });
});
