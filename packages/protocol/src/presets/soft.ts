import type { ThemePreset } from '../theme.js';

/** `soft` preset: pastel candy colors, white rims. Transcribed from the prototype's `PRESETS.soft`. */
export const soft: ThemePreset = {
  shading: 'standard', textured: false, facade: 'soft', toneMapped: false, streetLife: true, edgeLines: false, flatRoofs: true, hazeOpacity: 0.5, grade: 0.35,
  palette: ['#FFD6E0', '#FFE8B8', '#CDEBDC', '#D7E3FF', '#EAD9FF', '#FFE3D1'],
  ground: 0xCDEBC4, road: 0xEDE4F6, pad: 0xFFF6EE, plaza: 0xFFEFE2, park: 0xBDE6B2, water: 0xA6DAF5, rim: 0xFFFFFF,
  trunk: 0xC99B7B, leafA: 0xA6E0B5, leafB: 0xFFC7DA, centerLine: 0xFFFFFF, crosswalkColor: 0xFFFFFF,
  landmark: { base: 0xFFE3D1, a: 0xFFD6E0, b: 0xFFFFFF, cone: 0xB9D2FF }, hemiMul: 0.95, sunMul: 0.45,
};
