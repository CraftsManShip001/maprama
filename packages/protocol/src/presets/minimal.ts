import type { ThemePreset } from '../theme.js';

/** `minimal` preset: untextured, muted, no facades. Transcribed from the prototype's `PRESETS.minimal`. */
export const minimal: ThemePreset = {
  shading: 'standard', textured: false, facade: 'none', toneMapped: false, streetLife: false, edgeLines: false, flatRoofs: false, hazeOpacity: 0.7, grade: 0.4,
  palette: ['#F4F4F2', '#E7EAEE', '#EEE9E2', '#E3E9E5', '#EFECF2', '#FFFFFF'],
  ground: 0xE4E8E1, road: 0xFAFAF8, pad: 0xEFEFEC, plaza: 0xECE9E3, park: 0xD2E1CB, water: 0xC1D8E7, rim: 0xD6D6D2,
  trunk: 0xB5AEA6, leafA: 0xB8CCB1, leafB: 0xADC3AB, centerLine: 0xFAFAF8, crosswalkColor: 0xE2E2DE,
  landmark: { base: 0xEFEFEC, a: 0xDDE1E6, b: 0xF7F7F5, cone: 0xD3D8DE }, hemiMul: 0.85, sunMul: 0.42,
};
