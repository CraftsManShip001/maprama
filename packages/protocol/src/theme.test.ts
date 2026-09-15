import { describe, expect, it } from 'vitest';
import {
  CINE,
  PRESET_DEFAULTS,
  PRESET_NAMES,
  PRESETS,
  TIMES,
  resolveTheme,
  validateThemeSpec,
  type PresetName,
  type ThemePreset,
} from './index.js';

describe('resolveTheme', () => {
  it('resolves an empty spec to realistic / day with base defaults', () => {
    const t = resolveTheme();
    expect(t.presetName).toBe('realistic');
    expect(t.preset).toBe(PRESETS.realistic);
    expect(t.timeOfDay).toBe('day');
    expect(t.cinematic).toBe(false);
    expect(t.shadows).toBe(true);
    expect(t.zoomOut).toBe('none');
    expect(t.time).toEqual(TIMES.day);
    expect(t.buildings).toEqual({ facade: true, outline: false, massing: 'box', details: false, heightScale: 1 });
    expect(t.roads).toEqual({ laneMarkings: true, crosswalks: true });
    expect(t.street).toEqual({ props: true, parked: false, traffic: false });
    expect(resolveTheme({})).toEqual(t);
  });

  it('applies PRESET_DEFAULTS of the chosen preset', () => {
    for (const name of PRESET_NAMES) {
      const d = PRESET_DEFAULTS[name];
      const t = resolveTheme({ base: name });
      expect(t.presetName).toBe(name);
      expect(t.buildings.facade).toBe(d.facade);
      expect(t.buildings.outline).toBe(d.outline);
      expect(t.buildings.massing).toBe(d.massing);
      expect(t.buildings.details).toBe(d.details ?? false);
      expect(t.cinematic).toBe(d.cine ?? false);
      expect(t.roads).toEqual({ laneMarkings: d.lanes, crosswalks: d.crosswalks });
      expect(t.street).toEqual({ props: d.props, parked: d.parked, traffic: d.traffic });
      expect(t.buildings.heightScale).toBe(PRESETS[name].heightScale ?? 1);
    }
  });

  it('merges CINE over TIMES when cinematic (urban defaults to cinematic)', () => {
    const t = resolveTheme({ base: 'urban', timeOfDay: 'dusk' });
    expect(t.cinematic).toBe(true);
    expect(t.buildings.massing).toBe('varied');
    expect(t.buildings.heightScale).toBe(1.6);
    expect(t.time).toEqual({ ...TIMES.dusk, ...CINE.dusk });
    expect(t.time.fog).toBe(0xc98c7c);
    expect(t.time.hemiI).toBe(TIMES.dusk.hemiI);
    expect(t.time.grade).toBe(CINE.dusk.grade);
  });

  it('lets spec fields win over preset defaults', () => {
    const t = resolveTheme({
      base: 'urban',
      timeOfDay: 'golden',
      cinematic: false,
      shadows: false,
      buildings: { massing: 'box', heightScale: 2, details: false, outline: true },
      roads: { crosswalks: false },
      street: { traffic: false },
      zoomOut: 'keepGameView',
    });
    expect(t.cinematic).toBe(false);
    expect(t.time).toEqual(TIMES.golden);
    expect(t.time.grade).toBeUndefined();
    expect(t.shadows).toBe(false);
    expect(t.buildings).toEqual({ facade: true, outline: true, massing: 'box', details: false, heightScale: 2 });
    expect(t.roads).toEqual({ laneMarkings: true, crosswalks: false });
    expect(t.street).toEqual({ props: true, parked: true, traffic: false });
    expect(t.zoomOut).toBe('keepGameView');
  });

  it('turns cinematic on for a preset that defaults it off', () => {
    const t = resolveTheme({ base: 'toy', cinematic: true, timeOfDay: 'night' });
    expect(t.time.lights).toBe(1.6);
    expect(t.time.fog).toBe(TIMES.night.fog);
    expect(t.buildings.outline).toBe(true);
  });

  it('returns a fresh time object (no aliasing of frozen data)', () => {
    const t = resolveTheme({ timeOfDay: 'day' });
    expect(t.time).not.toBe(TIMES.day);
    expect(Object.isFrozen(t.time)).toBe(false);
  });

  it('accepts a custom preset object with realistic defaults', () => {
    const custom: ThemePreset = { ...PRESETS.soft, palette: ['#000000'], heightScale: 3 };
    const t = resolveTheme({ base: custom });
    expect(t.presetName).toBeNull();
    expect(t.preset).toBe(custom);
    expect(t.buildings.heightScale).toBe(3);
    expect(t.street.traffic).toBe(PRESET_DEFAULTS.realistic.traffic);
  });

  it('falls back to realistic for an unknown preset name at runtime', () => {
    const t = resolveTheme({ base: 'nope' as PresetName });
    expect(t.presetName).toBe('realistic');
    expect(t.preset).toBe(PRESETS.realistic);
  });
});

describe('validateThemeSpec', () => {
  it('accepts valid specs', () => {
    expect(validateThemeSpec({})).toEqual({ ok: true });
    expect(validateThemeSpec({ base: 'soft', timeOfDay: 'night', buildings: { massing: 'varied' } })).toEqual({ ok: true });
    expect(validateThemeSpec({ base: PRESETS.modern })).toEqual({ ok: true });
  });

  it('rejects invalid specs with a path', () => {
    const r1 = validateThemeSpec({ base: 'neon' });
    expect(r1.ok).toBe(false);
    const r2 = validateThemeSpec({ buildings: { massing: 'tall' } });
    expect(r2).toMatchObject({ ok: false });
    if (!r2.ok) expect(r2.error).toContain('$.buildings.massing');
    const r3 = validateThemeSpec({ base: { ...PRESETS.urban, ground: '#fff' } });
    expect(r3.ok).toBe(false);
    expect(validateThemeSpec(null).ok).toBe(false);
  });
});
