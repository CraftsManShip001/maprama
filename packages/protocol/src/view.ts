/**
 * Render view mode: the 2.5D diorama the engine is built around, and a flat 2D
 * map mode an app can switch to at any time.
 *
 * The mode is **the app's choice, never the engine's**: nothing switches it
 * automatically (not a zoom threshold, not a device class, not reduced motion).
 * `ZoomOutBehavior` — which *is* driven by the camera distance — stays a
 * separate, orthogonal knob.
 *
 * What `'2d'` means is defined by the renderer, not by the camera alone
 * (a pitch of 0 over extruded buildings is a top-down 2.5D view, not a map):
 *
 * - buildings lose their extrusion and are drawn as filled footprints with an
 *   outline,
 * - shadows are off (a shadow exists to read height, and there is none),
 * - the pitch is 0 **and locked**, gestures included,
 * - anchors that float (holo labels, drop items, info cards on roofs) come down
 *   to the ground, so a pin sits on its coordinate instead of beside it,
 * - distance fog is off (at pitch 0 the whole ground plane is roughly equally
 *   far away, so fog is a flat wash over the picture rather than depth).
 *
 * @module
 */

import { oneOf, type Check } from './internal/validate.js';

/** Render view modes. */
export const VIEW_MODES = ['2.5d', '2d'] as const;

/**
 * Render view mode.
 *
 * - `'2.5d'` (default): the tilted diorama with extruded buildings.
 * - `'2d'`: a flat map — footprints, no shadows, pitch locked at 0.
 */
export type ViewMode = (typeof VIEW_MODES)[number];

/** The engine's default view mode. */
export const DEFAULT_VIEW_MODE: ViewMode = '2.5d';

/**
 * Default duration of a view transition, in milliseconds, when `animate: true`
 * is given without one. Long enough to read the buildings growing or sinking,
 * short enough that the map is not unusable meanwhile.
 */
export const VIEW_TRANSITION_MS = 450;

/** Validates a {@link ViewMode}. */
export const checkViewMode: Check = oneOf(VIEW_MODES);
