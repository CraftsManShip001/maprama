/**
 * Map labels drawn by the engine (roads, districts, POIs) and how hosts
 * customise their content.
 *
 * @module
 */

import { checkLngLat, type LngLat } from './geo.js';
import { boolean, nonEmptyString, object, oneOf, string, type Check } from './internal/validate.js';
import { POI_CATEGORIES, type PoiCategory } from './world.js';

/** Label visual styles. */
export const LABEL_STYLES = ['app', 'minimal', 'clean', 'sticker', 'ground', 'sign', 'holo'] as const;
/**
 * Label visual style: `app` (map-app pills), `minimal`, `clean`, `sticker`,
 * `ground` (painted on the ground), `sign` (3D signposts), `holo` (holographic
 * floating tiles).
 */
export type LabelStyle = (typeof LABEL_STYLES)[number];

/** Icon tile treatments for the `holo` style. */
export const HOLO_ICON_TILES = ['auto', 'white', 'black', 'color'] as const;
/** Icon tile treatment for `holo` labels. */
export type HoloIconTile = (typeof HOLO_ICON_TILES)[number];

/** Label content modes. */
export const LABEL_CONTENT_MODES = ['nameAndType', 'nameOnly', 'textOnly', 'custom'] as const;
/**
 * What a label shows: `nameAndType` (name + category subtitle + icon),
 * `nameOnly` (name + icon), `textOnly` (name, no icon), `custom` (host supplies
 * content per label via `setLabelContent`).
 */
export type LabelContentMode = (typeof LABEL_CONTENT_MODES)[number];

/** Label kinds. */
export const LABEL_KINDS = ['road', 'district', 'poi'] as const;
/** What a label names. */
export type LabelKind = (typeof LABEL_KINDS)[number];

/** Icons a label may show. */
export const LABEL_ICONS = [...POI_CATEGORIES, 'avenue', 'street', 'district', 'water'] as const;
/** Label icon: a POI category or one of the road/area icons. */
export type LabelIcon = PoiCategory | 'avenue' | 'street' | 'district' | 'water';

/**
 * Public label configuration.
 *
 * Absent fields use the engine defaults: labels are **enabled** with the
 * `holo` style, `icons: 'auto'` and `content: 'nameAndType'`. So `{}` shows
 * holo labels; send `{ enabled: false }` to hide them.
 */
export interface LabelsSpec {
  /** Show labels. */
  enabled?: boolean;
  style?: LabelStyle;
  /** Icon tile treatment (applies to `holo`). */
  icons?: HoloIconTile;
  content?: LabelContentMode;
}

/** A label the engine can display, reported via the `labelsIndex` event. */
export interface LabelInfo {
  /** Stable label id (key for `setLabelContent`). */
  id: string;
  kind: LabelKind;
  /** Default text. */
  name: string;
  /** POI category, for `kind: 'poi'`. */
  category?: PoiCategory;
  /** Default subtitle, if any. */
  subtitle?: string;
  /** Label anchor. */
  lngLat: LngLat;
}

/** Host-supplied content for one label (used with `content: 'custom'`). */
export interface LabelContent {
  title: string;
  subtitle?: string;
  icon?: LabelIcon;
}

/** @internal */
export const checkLabelsSpec: Check = object(
  {},
  {
    enabled: boolean,
    style: oneOf(LABEL_STYLES),
    icons: oneOf(HOLO_ICON_TILES),
    content: oneOf(LABEL_CONTENT_MODES),
  },
);

/** @internal */
export const checkLabelInfo: Check = object(
  { id: nonEmptyString, kind: oneOf(LABEL_KINDS), name: string, lngLat: checkLngLat },
  { category: oneOf(POI_CATEGORIES), subtitle: string },
);

/** @internal */
export const checkLabelContent: Check = object(
  { title: string },
  { subtitle: string, icon: oneOf(LABEL_ICONS) },
);
