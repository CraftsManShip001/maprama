import { describe, expect, it } from 'vitest';
import { sampleWorld } from './__fixtures__/world.js';
import { validateWorldData, validateWorldSource } from './index.js';

describe('validateWorldData', () => {
  it('accepts a valid world (with and without optional fields)', () => {
    expect(validateWorldData(sampleWorld())).toEqual({ ok: true });
    const w = sampleWorld();
    delete w.plaza;
    expect(validateWorldData(w)).toEqual({ ok: true });
    expect(validateWorldData(JSON.parse(JSON.stringify(sampleWorld())))).toEqual({ ok: true });
  });

  const cases: [string, (w: any) => void, string][] = [
    ['wrong version', (w) => (w.version = 2), '$.version'],
    ['missing name', (w) => delete w.name, '$.name'],
    ['bad origin', (w) => (w.origin.lat = 91), '$.origin.lat'],
    ['non-positive unitMeters', (w) => (w.unitMeters = 0), '$.unitMeters'],
    ['road with 1 point', (w) => (w.roads[0].pts = [[0, 0]]), '$.roads[0].pts'],
    ['road bad class', (w) => (w.roads[1].cls = 'highway'), '$.roads[1].cls'],
    ['building footprint too short', (w) => (w.buildings[1].footprint = [[0, 0], [1, 1]]), '$.buildings[1].footprint'],
    ['building vertex not a pair', (w) => (w.buildings[0].footprint[2] = [1, 2, 3]), '$.buildings[0].footprint[2]'],
    ['building NaN height', (w) => (w.buildings[0].height = Number.NaN), '$.buildings[0].height'],
    ['poi bad category', (w) => (w.pois[0].cat = 'bar'), '$.pois[0].cat'],
    ['station missing x', (w) => delete w.stations[0].x, '$.stations[0].x'],
    ['attribution not strings', (w) => (w.attribution = [1]), '$.attribution[0]'],
    ['plaza wrong shape', (w) => (w.plaza = [0, 0]), '$.plaza'],
  ];

  for (const [name, mutate, path] of cases) {
    it(`rejects: ${name}`, () => {
      const w = sampleWorld();
      mutate(w);
      const r = validateWorldData(w);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.startsWith(path)).toBe(true);
    });
  }

  it('rejects non-objects without throwing', () => {
    for (const v of [null, undefined, 1, 'world', [], true]) {
      expect(validateWorldData(v).ok).toBe(false);
    }
  });
});

describe('validateWorldSource', () => {
  it('accepts every kind', () => {
    expect(validateWorldSource({ kind: 'data', world: sampleWorld() })).toEqual({ ok: true });
    expect(validateWorldSource({ kind: 'url', url: 'https://example.com/world.json' })).toEqual({ ok: true });
    expect(validateWorldSource({ kind: 'procedural', layout: 'town', seed: 7 })).toEqual({ ok: true });
    expect(validateWorldSource({ kind: 'procedural', layout: 'grid' })).toEqual({ ok: true });
  });

  it('rejects unknown kinds and bad variants', () => {
    expect(validateWorldSource({ kind: 'tiles' }).ok).toBe(false);
    expect(validateWorldSource({ kind: 'procedural', layout: 'maze' }).ok).toBe(false);
    expect(validateWorldSource({ kind: 'url', url: '' }).ok).toBe(false);
    expect(validateWorldSource({ world: sampleWorld() }).ok).toBe(false);
  });
});
