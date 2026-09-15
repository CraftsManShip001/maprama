import type { TimeOfDay, TimeOfDayPreset } from '../theme.js';

/** Lighting and atmosphere per time of day. Transcribed from the prototype's `TIMES`. */
export const TIMES: Record<TimeOfDay, TimeOfDayPreset> = {
  day: { fog: 0xD9DFE0, fogNear: 45, fogFar: 150, sun: 0xFFE4BC, sunI: 2.5, hemiSky: 0xC9DBEF, hemiGround: 0xA39480, hemiI: 0.95, dir: [30, 30, 24], lights: 0, exposure: 0.84,
    haze: 'linear-gradient(180deg, rgba(196,214,230,.82) 0%, rgba(226,224,212,.42) 20%, rgba(0,0,0,0) 46%)',
    vignette: 'radial-gradient(130% 95% at 30% 22%, rgba(255,236,200,.16) 0%, rgba(0,0,0,0) 40%, rgba(36,44,58,.3) 100%)' },
  golden: { fog: 0xE6C8A4, fogNear: 38, fogFar: 135, sun: 0xFFB566, sunI: 3.4, hemiSky: 0xB9D2E8, hemiGround: 0x76675A, hemiI: 0.78, dir: [40, 17, 27], lights: 0.25, exposure: 0.96, rays: true,
    haze: 'linear-gradient(180deg, rgba(118,168,212,.74) 0%, rgba(255,214,160,.52) 18%, rgba(255,190,120,.24) 36%, rgba(0,0,0,0) 56%)',
    vignette: 'radial-gradient(85% 65% at 90% 10%, rgba(255,204,120,.5) 0%, rgba(255,170,90,.14) 38%, rgba(0,0,0,0) 62%), radial-gradient(130% 100% at 45% 55%, rgba(0,0,0,0) 55%, rgba(34,26,44,.36) 100%)' },
  dusk: { fog: 0xDE9C7E, fogNear: 32, fogFar: 128, sun: 0xFF8A4A, sunI: 3.0, hemiSky: 0xF0B596, hemiGround: 0x47395A, hemiI: 0.72, dir: [46, 10, 14], lights: 0.85, exposure: 1.0,
    haze: 'linear-gradient(180deg, rgba(74,70,128,.78) 0%, rgba(214,120,110,.55) 17%, rgba(255,176,118,.3) 34%, rgba(0,0,0,0) 54%)',
    vignette: 'radial-gradient(120% 90% at 78% 26%, rgba(255,160,80,.22) 0%, rgba(0,0,0,0) 42%, rgba(46,20,44,.42) 100%)' },
  night: { fog: 0x1A2340, fogNear: 34, fogFar: 125, sun: 0x9DB2FF, sunI: 0.5, hemiSky: 0x47578A, hemiGround: 0x0E1119, hemiI: 0.6, dir: [-18, 40, -24], lights: 1.5, exposure: 1.1,
    haze: 'linear-gradient(180deg, rgba(8,12,30,.82) 0%, rgba(26,36,66,.45) 24%, rgba(0,0,0,0) 50%)',
    vignette: 'radial-gradient(120% 90% at 50% 45%, rgba(0,0,0,0) 50%, rgba(4,6,16,.5) 100%)' },
};

/**
 * Cinematic grading overrides per time of day, merged over {@link TIMES} when
 * cinematic grading is on. Transcribed from the prototype's `CINE`.
 */
export const CINE: Record<TimeOfDay, Partial<TimeOfDayPreset>> = {
  day: { fog: 0xDCE0DC, sun: 0xFFDDB0, hemiSky: 0xD3E0EC, hemiGround: 0xB09C84, dir: [30, 26, 24], exposure: 0.86,
    haze: 'linear-gradient(180deg, rgba(200,216,230,.8) 0%, rgba(240,226,204,.48) 20%, rgba(0,0,0,0) 46%)',
    vignette: 'radial-gradient(130% 95% at 28% 20%, rgba(255,230,190,.22) 0%, rgba(0,0,0,0) 42%, rgba(40,44,58,.3) 100%)',
    grade: 'linear-gradient(160deg, rgba(255,206,150,.45) 0%, rgba(255,240,220,.1) 45%, rgba(110,140,190,.34) 100%)' },
  golden: { grade: 'linear-gradient(135deg, rgba(255,166,76,.58) 0%, rgba(255,222,170,.14) 45%, rgba(36,112,150,.48) 100%)' },
  dusk: { fog: 0xC98C7C, fogNear: 30, fogFar: 125, sun: 0xFF7A3D, sunI: 3.2, hemiSky: 0xE9A58C, hemiGround: 0x3A2E52, dir: [46, 9, 14], lights: 0.95, exposure: 1.02,
    haze: 'linear-gradient(180deg, rgba(62,58,120,.84) 0%, rgba(206,106,112,.6) 16%, rgba(255,164,104,.36) 33%, rgba(0,0,0,0) 54%)',
    vignette: 'radial-gradient(120% 90% at 80% 24%, rgba(255,150,70,.28) 0%, rgba(0,0,0,0) 42%, rgba(40,16,44,.48) 100%)',
    grade: 'linear-gradient(200deg, rgba(255,128,56,.55) 0%, rgba(240,110,120,.2) 45%, rgba(70,40,130,.5) 100%)' },
  night: { lights: 1.6, grade: 'linear-gradient(180deg, rgba(50,70,160,.45) 0%, rgba(120,90,200,.12) 50%, rgba(255,170,90,.2) 100%)' },
};
