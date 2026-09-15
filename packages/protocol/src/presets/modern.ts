import type { ThemePreset } from '../theme.js';

/** `modern` preset: dark roads, flat roofs, modern facades. Transcribed from the prototype's `PRESETS.modern`. */
export const modern: ThemePreset = {
  shading: 'standard', textured: false, facade: 'modern', toneMapped: true, streetLife: true, edgeLines: true, flatRoofs: true, hazeOpacity: 1, grade: 1,
  palette: ['#F3F0EB', '#E7E3DC', '#DCE1E4', '#EEE7DD', '#D3DAD6', '#E8E4EC'],
  ground: 0xA9BCA0, road: 0x5A5F67, pad: 0xD3D0C9, plaza: 0xE0DACF, park: 0x94B486, water: 0x6A9DBA, rim: 0xCFC9BF,
  trunk: 0x6B5A4C, leafA: 0x86A873, leafB: 0x5F8E68, centerLine: 0xE9D8A6, crosswalkColor: 0xEFEDE8,
  landmark: { base: 0xE9E4DC, a: 0xFFFFFF, b: 0xF4F1EC, cone: 0xC8B597, glass: 'modern' }, hemiMul: 1.05, sunMul: 1.0,
};
