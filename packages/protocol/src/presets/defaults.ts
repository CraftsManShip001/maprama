import type { PresetDefaults, PresetName } from '../theme.js';

/** Default option toggles applied when a preset is chosen. Transcribed from the prototype's `PRESET_DEFAULTS`. */
export const PRESET_DEFAULTS: Record<PresetName, PresetDefaults> = {
  realistic: { facade: true, outline: false, massing: 'box', lanes: true, crosswalks: true, props: true, parked: false, traffic: false },
  toy: { facade: true, outline: true, massing: 'box', lanes: true, crosswalks: false, props: false, parked: false, traffic: false },
  minimal: { facade: false, outline: false, massing: 'box', lanes: true, crosswalks: false, props: false, parked: false, traffic: false },
  modern: { facade: true, outline: false, massing: 'varied', lanes: true, crosswalks: true, props: true, parked: true, traffic: true, cine: true, details: true },
  urban: { facade: true, outline: false, massing: 'varied', lanes: true, crosswalks: true, props: true, parked: true, traffic: true, cine: true, details: true },
  soft: { facade: true, outline: false, massing: 'box', details: false, lanes: true, crosswalks: true, props: true, parked: false, traffic: true, cine: false },
};
