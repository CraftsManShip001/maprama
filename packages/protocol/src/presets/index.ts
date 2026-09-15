/**
 * Built-in theme data, transcribed exactly from the browser prototype
 * (`reference/preview/engine-preview.js`). All exported objects are deeply
 * frozen; copy before modifying.
 *
 * This module imports only types from `theme.ts`, so there is no runtime
 * import cycle.
 *
 * @module
 */

import type { PresetDefaults, PresetName, ThemePreset, TimeOfDay, TimeOfDayPreset } from '../theme.js';
import { PRESET_DEFAULTS as RAW_PRESET_DEFAULTS } from './defaults.js';
import { minimal } from './minimal.js';
import { modern } from './modern.js';
import { realistic } from './realistic.js';
import { soft } from './soft.js';
import { CINE as RAW_CINE, TIMES as RAW_TIMES } from './times.js';
import { INK, toy } from './toy.js';
import { urban } from './urban.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** All built-in presets by name (deeply frozen). */
export const PRESETS: Readonly<Record<PresetName, ThemePreset>> = deepFreeze({
  realistic,
  toy,
  minimal,
  modern,
  urban,
  soft,
});

/** Default option toggles per preset (deeply frozen). */
export const PRESET_DEFAULTS: Readonly<Record<PresetName, PresetDefaults>> = deepFreeze(RAW_PRESET_DEFAULTS);

/** Lighting and atmosphere per time of day (deeply frozen). */
export const TIMES: Readonly<Record<TimeOfDay, TimeOfDayPreset>> = deepFreeze(RAW_TIMES);

/** Cinematic overrides per time of day (deeply frozen). */
export const CINE: Readonly<Record<TimeOfDay, Partial<TimeOfDayPreset>>> = deepFreeze(RAW_CINE);

export { INK, minimal, modern, realistic, soft, toy, urban };
