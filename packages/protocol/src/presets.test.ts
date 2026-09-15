import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CINE,
  INK,
  PRESET_DEFAULTS,
  PRESET_NAMES,
  PRESETS,
  TIMES,
  TIMES_OF_DAY,
  soft,
  urban,
  validateThemePreset,
} from './index.js';

const PROTOTYPE_PATH = fileURLToPath(new URL('../../../reference/preview/engine-preview.js', import.meta.url));

describe('preset data samples (transcribed from the prototype)', () => {
  it('matches spot-checked values', () => {
    expect(urban.heightScale).toBe(1.6);
    expect(soft.palette[0]).toBe('#FFD6E0');
    expect(TIMES.golden.rays).toBe(true);
    expect(TIMES.day.rays).toBeUndefined();
    expect(PRESETS.toy.rim).toBe(0x2a2540);
    expect(INK).toBe(0x2a2540);
    expect(PRESETS.toy.shading).toBe('toon');
    expect(PRESETS.realistic.landmark.glass).toBe('real');
    expect(PRESETS.realistic.water).toBe(0x4a7896);
    expect(PRESETS.minimal.facade).toBe('none');
    expect(PRESETS.modern.grade).toBe(1);
    expect(PRESETS.modern.road).toBe(0x5a5f67);
    expect(PRESETS.soft.landmark.glass).toBeUndefined();
    expect(PRESETS.realistic.heightScale).toBeUndefined();
    expect(PRESET_DEFAULTS.modern.cine).toBe(true);
    expect(PRESET_DEFAULTS.toy.outline).toBe(true);
    expect(PRESET_DEFAULTS.realistic.cine).toBeUndefined();
    expect(TIMES.night.dir).toEqual([-18, 40, -24]);
    expect(TIMES.dusk.fogFar).toBe(128);
    expect(CINE.night).toEqual({
      lights: 1.6,
      grade: 'linear-gradient(180deg, rgba(50,70,160,.45) 0%, rgba(120,90,200,.12) 50%, rgba(255,170,90,.2) 100%)',
    });
  });

  it('has exactly the documented preset and time names', () => {
    expect(Object.keys(PRESETS)).toEqual([...PRESET_NAMES]);
    expect(Object.keys(PRESET_DEFAULTS)).toEqual([...PRESET_NAMES]);
    expect(Object.keys(TIMES)).toEqual([...TIMES_OF_DAY]);
    expect(Object.keys(CINE)).toEqual([...TIMES_OF_DAY]);
  });

  it('every preset passes validateThemePreset and survives JSON serialisation', () => {
    for (const name of PRESET_NAMES) {
      expect(validateThemePreset(PRESETS[name])).toEqual({ ok: true });
      expect(JSON.parse(JSON.stringify(PRESETS[name]))).toEqual(PRESETS[name]);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(PRESETS)).toBe(true);
    expect(Object.isFrozen(urban)).toBe(true);
    expect(Object.isFrozen(urban.palette)).toBe(true);
    expect(Object.isFrozen(urban.landmark)).toBe(true);
    expect(Object.isFrozen(TIMES.day.dir)).toBe(true);
    expect(Object.isFrozen(CINE.golden)).toBe(true);
    expect(Object.isFrozen(PRESET_DEFAULTS.soft)).toBe(true);
  });
});

describe.skipIf(!existsSync(PROTOTYPE_PATH))('preset data equals the prototype source exactly', () => {
  /** Evaluates the prototype's pure "constants & themes" block in isolation. */
  function loadPrototypeConstants(): Record<string, unknown> {
    const source = readFileSync(PROTOTYPE_PATH, 'utf8');
    const start = source.indexOf('/* ---------------- constants & themes ---------------- */');
    const end = source.indexOf('function tp()');
    if (start < 0 || end < 0 || end <= start) throw new Error('prototype constants block not found');
    const block = source.slice(start, end);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`${block}\nreturn { PRESETS, PRESET_DEFAULTS, TIMES, CINE, INK };`)() as Record<string, unknown>;
  }

  const proto = loadPrototypeConstants();

  it('PRESETS', () => {
    expect(PRESETS).toStrictEqual(proto.PRESETS);
  });
  it('PRESET_DEFAULTS', () => {
    expect(PRESET_DEFAULTS).toStrictEqual(proto.PRESET_DEFAULTS);
  });
  it('TIMES', () => {
    expect(TIMES).toStrictEqual(proto.TIMES);
  });
  it('CINE', () => {
    expect(CINE).toStrictEqual(proto.CINE);
  });
  it('INK', () => {
    expect(INK).toBe(proto.INK);
  });
});
