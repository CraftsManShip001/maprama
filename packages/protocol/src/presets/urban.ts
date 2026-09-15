import type { ThemePreset } from '../theme.js';

/** `urban` preset: taller dense city, urban facades. Transcribed from the prototype's `PRESETS.urban`. */
export const urban: ThemePreset = {
  shading: 'standard', textured: false, facade: 'urban', toneMapped: true, streetLife: true, edgeLines: true, flatRoofs: true, heightScale: 1.6, hazeOpacity: 1, grade: 0.9,
  palette: ['#FFFFFF', '#E6EAEE', '#D9DEE3', '#F0F1F2', '#DCE3E8', '#E8E6E3'],
  ground: 0x8E9A8C, road: 0x464A51, pad: 0xB8BBBE, plaza: 0xC9CBCB, park: 0x7F9A76, water: 0x5F8BA6, rim: 0xA9ADB0,
  trunk: 0x5B5048, leafA: 0x6E9063, leafB: 0x4F7A58, centerLine: 0xE3C372, crosswalkColor: 0xE6E7E6,
  landmark: { base: 0xB9BEC3, a: 0xFFFFFF, b: 0xD8DCDF, cone: 0x8D98A3, glass: 'urban' }, hemiMul: 1.0, sunMul: 1.0,
};
