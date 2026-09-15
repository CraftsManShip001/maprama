import type { ThemePreset } from '../theme.js';

/** `realistic` preset: textured, tone-mapped, real-world facades. Transcribed from the prototype's `PRESETS.realistic`. */
export const realistic: ThemePreset = {
  shading: 'standard', textured: true, facade: 'real', toneMapped: true, streetLife: true, edgeLines: true, flatRoofs: false, hazeOpacity: 1, grade: 0.75,
  palette: ['#FFFFFF', '#F3EADF', '#E4EBF1', '#EDE1D8', '#E1E7DE', '#F6F2EA'],
  ground: 0xFFFFFF, road: 0xFFFFFF, pad: 0xFFFFFF, plaza: 0xFFFFFF, park: 0xFFFFFF, water: 0x4A7896, rim: 0xA8A195,
  trunk: 0x5E4A3B, leafA: 0x587C45, leafB: 0x3E6346, centerLine: 0xD9A935, crosswalkColor: 0xD9D8D3,
  landmark: { base: 0xC9C2B6, a: 0xFFFFFF, b: 0xDEDAD3, cone: 0x7E8A96, glass: 'real' }, hemiMul: 1.0, sunMul: 1.0,
};
