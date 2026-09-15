import type { ThemePreset } from '../theme.js';

/** Outline ink color used by the `toy` preset (the prototype's `INK`). */
export const INK = 0x2A2540;

/** `toy` preset: toon shading, pastel colors, ink outlines. Transcribed from the prototype's `PRESETS.toy`. */
export const toy: ThemePreset = {
  shading: 'toon', textured: false, facade: 'toy', toneMapped: false, streetLife: false, edgeLines: false, flatRoofs: false, hazeOpacity: 0.55, grade: 0.45,
  palette: ['#F7C5B5', '#BFD7F2', '#F4E2A8', '#D4C6EF', '#C6E6D0', '#FAD0DE'],
  ground: 0xD6E9CB, road: 0xE2DEEC, pad: 0xF6F3EE, plaza: 0xF1E6D6, park: 0xBFE2B0, water: 0xA6D6F2, rim: INK,
  trunk: 0xB98B6A, leafA: 0x9CD68F, leafB: 0x7FC7A0, centerLine: 0xFBFAFF, crosswalkColor: 0xFFFFFF,
  landmark: { base: 0xFFD6A5, a: 0xF7A8B8, b: 0xFFFFFF, cone: 0x6F8EF6 }, hemiMul: 0.7, sunMul: 0.36,
};
