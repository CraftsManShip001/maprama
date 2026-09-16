/**
 * Holographic info cards: a structured place card the engine draws floating
 * over a coordinate (`setInfoCard` / `removeInfoCard`).
 *
 * The content is a **fixed schema**, not host markup: the same card has to be
 * drawable by the web engine (DOM) and the native engine (platform views), it
 * has to be readable by a screen reader in a defined order, and accepting
 * arbitrary HTML from app data would be an injection hole. An app that needs
 * free rendering uses `<MapOverlay>` + `project()` instead.
 *
 * The engine **never opens a card by itself**: showing one, moving the camera
 * (`focusOn`) and reacting to `infoCard:press` / `infoCard:dismiss` are the
 * app's decisions. See the guide for how the three are wired together.
 *
 * @module
 */

import { checkLngLat, type LngLat } from './geo.js';
import {
  array,
  boolean,
  nonEmptyString,
  nonNegativeNumber,
  number,
  object,
  oneOf,
  positiveNumber,
  string,
  type Check,
} from './internal/validate.js';
import { LABEL_ICONS, type LabelIcon } from './labels.js';

/** Where the card's beam starts. */
export const INFO_CARD_ANCHORS = ['ground', 'roof', 'auto'] as const;
/**
 * Where the card's beam starts: `ground` (the map surface under the
 * coordinate), `roof` (the top of the building the coordinate falls in, the
 * ground when there is none) or `auto` (the default: `roof` when a building
 * covers the coordinate, otherwise `ground`).
 */
export type InfoCardAnchor = (typeof INFO_CARD_ANCHORS)[number];

/** Badge tones. */
export const INFO_BADGE_TONES = ['neutral', 'good', 'warn', 'bad'] as const;
/**
 * Colour role of a badge — `good` for "open now", `warn` for "closing soon",
 * `bad` for "closed", `neutral` (the default) for anything else. A tone, not a
 * colour: each engine paints it from the active theme.
 */
export type InfoBadgeTone = (typeof INFO_BADGE_TONES)[number];

/** Icons a detail row may show. */
export const INFO_ROW_ICONS = ['hours', 'location', 'phone', 'link', 'info', 'price'] as const;
/**
 * Icon of a detail row. A small closed set on purpose: every engine ships the
 * same glyphs, so a card looks the same on web and native. (It does not overlap
 * {@link LabelIcon}, which is a set of *place categories* — the card's own
 * `content.icon` uses that one.)
 */
export type InfoRowIcon = (typeof INFO_ROW_ICONS)[number];

/** A short status chip, e.g. `{ text: '영업 중', tone: 'good' }`. */
export interface InfoCardBadge {
  text: string;
  /** Default `'neutral'`. */
  tone?: InfoBadgeTone;
}

/** A star rating with an optional review count. */
export interface InfoCardRating {
  /** Rating on a 0–5 scale. */
  value: number;
  /** Number of reviews, shown next to the value when present. */
  count?: number;
}

/** One detail line of a card (opening hours, address, phone…). */
export interface InfoCardRow {
  text: string;
  icon?: InfoRowIcon;
}

/** A button on a card. Pressing it emits `infoCard:press` with this `id`. */
export interface InfoCardAction {
  /** Action id, unique within the card; reported back as `infoCard:press.actionId`. */
  id: string;
  label: string;
  /** Draw as the primary (filled) button. Default false. */
  primary?: boolean;
}

/**
 * What a card shows, in the order a screen reader announces it: title,
 * subtitle, badges, rating, rows, actions.
 */
export interface InfoCardContent {
  title: string;
  /** Category or one-line description under the title. */
  subtitle?: string;
  /** Place-category icon shown next to the title. */
  icon?: LabelIcon;
  badges?: InfoCardBadge[];
  rating?: InfoCardRating;
  rows?: InfoCardRow[];
  actions?: InfoCardAction[];
}

/**
 * One info card. Cards are keyed by `id`: sending `setInfoCard` with an id that
 * already exists replaces that card in place (an engine must not rebuild a card
 * whose content did not change), and several cards can be on screen at once —
 * showing only one is an app policy, not an engine limit.
 */
export interface InfoCardSpec {
  /** Stable card id, unique per map. */
  id: string;
  coordinate: LngLat;
  /** Default `'auto'`. */
  anchor?: InfoCardAnchor;
  /**
   * How far above the anchor the card floats, in meters. Defaults to
   * {@link INFO_CARD_GROUND_HEIGHT_METERS} for a ground anchor and
   * {@link INFO_CARD_ROOF_HEIGHT_METERS} above a roof.
   */
  heightMeters?: number;
  content: InfoCardContent;
  /** Draw the ground dot and the leader line. Default true. */
  beam?: boolean;
  /** Show a close button, which emits `infoCard:dismiss`. Default false. */
  dismissible?: boolean;
}

/**
 * Default height of a `ground`-anchored card above the map surface, in meters.
 *
 * Roughly three storeys: high enough to clear street furniture and the holo
 * labels (which float ~29 m up at the default world scale) without leaving the
 * card visually detached from its dot.
 */
export const INFO_CARD_GROUND_HEIGHT_METERS = 30;

/**
 * Default height of a `roof`-anchored card above the roof, in meters.
 *
 * Short on purpose: the roof already carries the card most of the way up, and a
 * long beam over a tall building pushes the card off the top of the screen.
 */
export const INFO_CARD_ROOF_HEIGHT_METERS = 12;

/** @internal */
const checkBadge: Check = object({ text: string }, { tone: oneOf(INFO_BADGE_TONES) });

/** @internal */
const checkRow: Check = object({ text: string }, { icon: oneOf(INFO_ROW_ICONS) });

/** @internal */
const checkAction: Check = object({ id: nonEmptyString, label: string }, { primary: boolean });

/** @internal */
export const checkInfoCardContent: Check = object(
  { title: string },
  {
    subtitle: string,
    icon: oneOf(LABEL_ICONS),
    badges: array(checkBadge),
    rating: object({ value: number }, { count: nonNegativeNumber }),
    rows: array(checkRow),
    actions: array(checkAction),
  },
);

/** @internal */
export const checkInfoCardSpec: Check = object(
  { id: nonEmptyString, coordinate: checkLngLat, content: checkInfoCardContent },
  {
    anchor: oneOf(INFO_CARD_ANCHORS),
    heightMeters: positiveNumber,
    beam: boolean,
    dismissible: boolean,
  },
);
