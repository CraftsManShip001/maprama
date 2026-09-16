/**
 * 2D ⇄ 2.5D view transition state.
 *
 * Pure (no three.js, no DOM) so the whole transition policy — easing,
 * retargeting, reduced motion, when the loop may go idle again — can be
 * unit-tested without a renderer. The renderer reads {@link ViewTransition.t}
 * once per frame and applies it; the engine holds one active render source
 * while {@link ViewTransition.animating} is true and releases it the moment the
 * transition lands, so a settled 2D map is as idle as a settled 2.5D one.
 *
 * `t` is "how flat the map is": 0 = the 2.5D diorama, 1 = the flat 2D map.
 *
 * @module
 */

import { DEFAULT_VIEW_MODE, VIEW_TRANSITION_MS, type ViewMode } from '@maprama/protocol';

/**
 * Distance from the target below which `t` snaps onto it and the transition is
 * over. The transition is a linear ramp with an eased read-out, so it reaches
 * its target exactly; this only guards floating-point dust.
 */
const SNAP = 1e-4;

/** Cubic ease-in-out, the same curve the camera transitions use. */
const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** How a `setView` was asked to animate: `true` / absent = the default duration. */
export type ViewAnimate = boolean | { durationMs: number } | undefined;

/** Resolves a `setView.animate` field to a duration in milliseconds (0 = instant). */
export function viewDurationMs(animate: ViewAnimate): number {
  if (animate === false) return 0;
  if (animate === undefined || animate === true) return VIEW_TRANSITION_MS;
  return Math.max(0, animate.durationMs);
}

export class ViewTransition {
  /** The mode the engine is in or moving to (it flips at the *start* of a transition). */
  mode: ViewMode = DEFAULT_VIEW_MODE;
  /** Flatness: 0 = 2.5D, 1 = 2D. */
  t = 0;
  /** Where `t` is heading (0 or 1). */
  private target = 0;
  /** Value `t` had when the current transition started. */
  private from = 0;
  /** Progress 0..1 along the current transition. */
  private p = 1;
  private durationS = 0;

  /** True while `t` is still moving. */
  get animating(): boolean {
    return this.p < 1;
  }

  /** True once the map is fully flat (the flat renderer owns the buildings). */
  get flat(): boolean {
    return this.t >= 1;
  }

  /**
   * Requests a mode.
   *
   * Retargeting mid-transition continues from the value `t` has **now** rather
   * than restarting, so "2d, 2.5d, 2d" in quick succession reads as one
   * continuous motion instead of three snaps. Returns `true` when this call
   * started (or reversed) a transition, `false` when the engine was already
   * there and nothing moves — the caller answers a no-op with a settled
   * `view:change` either way.
   */
  request(mode: ViewMode, durationMs: number, reduceMotion = false): boolean {
    const target = mode === '2d' ? 1 : 0;
    const wasMode = this.mode;
    this.mode = mode;
    if (target === this.target && !this.animating) return false;
    this.target = target;
    if (durationMs <= 0 || reduceMotion) {
      this.from = target;
      this.t = target;
      this.p = 1;
      return wasMode !== mode || this.t !== target;
    }
    this.from = this.t;
    this.p = 0;
    // A reversal mid-flight only has `|target − t|` of the way left to go: scaling the duration by
    // that fraction keeps the apparent speed constant instead of crawling back over a full duration.
    this.durationS = (durationMs / 1000) * Math.max(0.05, Math.abs(target - this.from));
    return true;
  }

  /**
   * Advances the transition. Returns `true` when `t` changed, i.e. when the
   * renderer has to re-apply the view this frame.
   */
  update(dt: number): boolean {
    if (this.p >= 1) return false;
    this.p = Math.min(1, this.p + dt / Math.max(1e-3, this.durationS));
    const next = this.from + (this.target - this.from) * ease(this.p);
    const changed = next !== this.t;
    this.t = Math.abs(this.target - next) < SNAP ? this.target : next;
    return changed;
  }
}
