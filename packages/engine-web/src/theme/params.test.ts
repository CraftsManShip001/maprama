import { PRESETS, TIMES } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { LIGHT_SCALE, renderParamsFor } from './params.js';

describe('renderParamsFor', () => {
  it('defaults to realistic day', () => {
    const p = renderParamsFor();
    expect(p.resolved.presetName).toBe('realistic');
    expect(p.textured).toBe(true);
    expect(p.facadeSet).toBe('real');
    expect(p.toneMapped).toBe(true);
    expect(p.exposure).toBe(0.84);
    expect(p.fog).toEqual({ color: 0xd9dfe0, near: 45, far: 150 });
    expect(p.lights).toBe(0);
    expect(p.overlays.grade).toBeNull();
    expect(p.overlays.rays).toBe(false);
  });

  it('scales light intensities for physically based lights', () => {
    const p = renderParamsFor({ base: 'toy', timeOfDay: 'golden' });
    expect(p.sun.intensity).toBeCloseTo(TIMES.golden.sunI * PRESETS.toy.sunMul * LIGHT_SCALE);
    expect(p.hemi.intensity).toBeCloseTo(TIMES.golden.hemiI * PRESETS.toy.hemiMul * LIGHT_SCALE);
    expect(p.overlays.rays).toBe(true);
  });

  it('urban: cinematic by default, varied massing, details, 1.6 height scale', () => {
    const p = renderParamsFor({ base: 'urban', timeOfDay: 'dusk' });
    expect(p.facadeSet).toBe('urban');
    expect(p.heightScale).toBe(1.6);
    expect(p.massing).toBe('varied');
    expect(p.details).toBe(true);
    expect(p.flatRoofs).toBe(true);
    expect(p.resolved.cinematic).toBe(true);
    expect(p.overlays.grade).toMatch(/^linear-gradient/);
    expect(p.fog.color).toBe(0xc98c7c); // CINE dusk override
    expect(p.palette[0]).toBe('#FFFFFF');
  });

  it('toy: toon shading with outlines, untextured, no tone mapping', () => {
    const p = renderParamsFor({ base: 'toy', timeOfDay: 'night' });
    expect(p.shading).toBe('toon');
    expect(p.outline).toBe(true);
    expect(p.toneMapped).toBe(false);
    expect(p.exposure).toBe(1);
    expect(p.lights).toBe(1.5);
  });

  it('soft: rounded pastel preset without details', () => {
    const p = renderParamsFor({ base: 'soft' });
    expect(p.facadeSet).toBe('soft');
    expect(p.details).toBe(false);
    expect(p.overlays.hazeOpacity).toBe(0.5);
    expect(p.preset.rim).toBe(0xffffff);
  });

  it('minimal disables facades; spec overrides win', () => {
    expect(renderParamsFor({ base: 'minimal' }).facadeOn).toBe(false);
    const p = renderParamsFor({ base: 'modern', cinematic: false, buildings: { details: false, heightScale: 2 }, roads: { crosswalks: false }, zoomOut: 'keepGameView' });
    expect(p.overlays.grade).toBeNull();
    expect(p.details).toBe(false);
    expect(p.heightScale).toBe(2);
    expect(p.roads.crosswalks).toBe(false);
    expect(p.zoomOut).toBe('keepGameView');
  });
});
