import { describe, expect, it } from 'vitest';
import { VIEW_TRANSITION_MS } from '@maprama/protocol';
import { ViewTransition, viewDurationMs } from './view-mode.js';

/** Runs the transition to completion at 60 fps and returns the `t` of every frame. */
function run(v: ViewTransition, maxFrames = 600): number[] {
  const out: number[] = [];
  for (let i = 0; i < maxFrames && v.animating; i++) {
    v.update(1 / 60);
    out.push(v.t);
  }
  return out;
}

describe('view transition duration', () => {
  it('animates by default and honours an explicit duration', () => {
    expect(viewDurationMs(undefined)).toBe(VIEW_TRANSITION_MS);
    expect(viewDurationMs(true)).toBe(VIEW_TRANSITION_MS);
    expect(viewDurationMs(false)).toBe(0);
    expect(viewDurationMs({ durationMs: 400 })).toBe(400);
    expect(viewDurationMs({ durationMs: -1 })).toBe(0);
  });
});

describe('view transition', () => {
  it('starts in the 2.5D view with nothing animating', () => {
    const v = new ViewTransition();
    expect(v.mode).toBe('2.5d');
    expect(v.t).toBe(0);
    expect(v.flat).toBe(false);
    expect(v.animating).toBe(false);
    expect(v.update(1 / 60)).toBe(false);
  });

  it('reaches exactly 1 and stops animating', () => {
    const v = new ViewTransition();
    expect(v.request('2d', 450)).toBe(true);
    const frames = run(v);
    expect(frames.length).toBeGreaterThan(5);
    expect(v.t).toBe(1);
    expect(v.flat).toBe(true);
    expect(v.animating).toBe(false);
    // Monotone: the buildings only ever sink on the way in.
    for (let i = 1; i < frames.length; i++) expect(frames[i]!).toBeGreaterThanOrEqual(frames[i - 1]!);
  });

  it('lands instantly with animate: false and with reduced motion', () => {
    const instant = new ViewTransition();
    instant.request('2d', 0);
    expect(instant.t).toBe(1);
    expect(instant.animating).toBe(false);

    const reduced = new ViewTransition();
    reduced.request('2d', 450, true);
    expect(reduced.t).toBe(1);
    expect(reduced.animating).toBe(false);
  });

  it('answers "already there" with false and moves nothing', () => {
    const v = new ViewTransition();
    expect(v.request('2.5d', 450)).toBe(false);
    expect(v.animating).toBe(false);
    v.request('2d', 0);
    expect(v.request('2d', 450)).toBe(false);
    expect(v.t).toBe(1);
    expect(v.animating).toBe(false);
  });

  it('retargets from where it is instead of restarting', () => {
    const v = new ViewTransition();
    v.request('2d', 450);
    for (let i = 0; i < 12; i++) v.update(1 / 60);
    const mid = v.t;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Reversing must continue from `mid`, not snap back to 1 or jump to 0.
    v.request('2.5d', 450);
    expect(v.mode).toBe('2.5d');
    expect(v.t).toBe(mid);
    const frames = run(v);
    expect(frames[0]!).toBeLessThan(mid);
    expect(v.t).toBe(0);
    expect(v.flat).toBe(false);
  });

  it('takes less time to reverse from halfway than to run the full way', () => {
    const full = new ViewTransition();
    full.request('2d', 450);
    const fullFrames = run(full).length;

    const half = new ViewTransition();
    half.request('2d', 450);
    while (half.t < 0.5) half.update(1 / 60);
    half.request('2.5d', 450);
    expect(run(half).length).toBeLessThan(fullFrames);
  });

  it('reports the mode from the first frame and flatness only at the end', () => {
    const v = new ViewTransition();
    v.request('2d', 450);
    expect(v.mode).toBe('2d');
    expect(v.flat).toBe(false);
    run(v);
    expect(v.flat).toBe(true);
  });
});
