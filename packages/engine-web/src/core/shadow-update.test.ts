import { describe, expect, it } from 'vitest';
import { SHADOW_INERT_SOURCES, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE_MOBILE, ShadowUpdatePolicy, shadowMapSizeFor } from './shadow-update.js';
import { FrameScheduler } from './frame-scheduler.js';

const state = (over: Partial<Parameters<ShadowUpdatePolicy['next']>[0]> = {}) => ({
  enabled: true, x: 0, z: 0, dirX: 30, dirY: 30, dirZ: 24, extent: 48, far: 160, moving: false, ...over,
});

describe('ShadowUpdatePolicy', () => {
  it('draws the first frame, then keeps the map while nothing changes', () => {
    const p = new ShadowUpdatePolicy();
    expect(p.next(state())).toBe(true);
    expect(p.next(state())).toBe(false);
    expect(p.next(state())).toBe(false);
  });

  it('redraws when the shadow camera follows the map camera', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ x: 0.01 }))).toBe(true);
    expect(p.next(state({ x: 0.01 }))).toBe(false);
    expect(p.next(state({ x: 0.01, z: -4 }))).toBe(true);
  });

  it('does not redraw when the camera only rotates or zooms (the sun does not move)', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state({ x: 12, z: -3 }));
    // a rotation / a zoom that stays below the zoom-out threshold leaves sun and frustum alone
    expect(p.next(state({ x: 12, z: -3 }))).toBe(false);
  });

  it('redraws when the sun direction or the zoom-out frustum changes', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ dirY: 18 }))).toBe(true);
    expect(p.next(state({ dirY: 18 }))).toBe(false);
    expect(p.next(state({ dirY: 18, extent: 60 }))).toBe(true);
    expect(p.next(state({ dirY: 18, extent: 60 }))).toBe(false);
    expect(p.next(state({ dirY: 18, extent: 60, far: 200 }))).toBe(true);
  });

  it('redraws for explicit invalidation exactly once', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state())).toBe(false);
    p.invalidate();
    expect(p.next(state())).toBe(true);
    expect(p.next(state())).toBe(false);
  });

  it('keeps redrawing while something moves, and once more on the frame it stops', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ moving: true }))).toBe(true);
    expect(p.next(state({ moving: true }))).toBe(true);
    // the source is released inside the frame hooks, i.e. before the decision, while the motion
    // it applied is still being drawn: that frame must still refresh the map
    expect(p.next(state({ moving: false }))).toBe(true);
    expect(p.next(state({ moving: false }))).toBe(false);
  });

  it('never draws while shadows are off, and draws again when they come back', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state());
    expect(p.next(state({ enabled: false }))).toBe(false);
    expect(p.next(state({ enabled: false, moving: true }))).toBe(false);
    expect(p.next(state())).toBe(true);
  });

  it('keeps a pending invalidation across frames without shadows', () => {
    const p = new ShadowUpdatePolicy();
    p.next(state({ enabled: false }));
    p.invalidate();
    expect(p.next(state({ enabled: false }))).toBe(false);
    expect(p.next(state())).toBe(true);
  });
});

describe('active sources that matter for shadows', () => {
  it('treats DOM-only and event-only tags as inert and everything else as scene motion', () => {
    const s = new FrameScheduler();
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
    const labels = s.addSource('labels');
    const cameraEvent = s.addSource('camera:change');
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
    const chars = s.addSource('chars');
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(true);
    chars();
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
    // an unknown tag (a third-party addActiveSource) counts as motion
    const other = s.addSource('my-extension');
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(true);
    other();
    labels();
    cameraEvent();
    expect(s.hasSourceExcept(SHADOW_INERT_SOURCES)).toBe(false);
  });
});

describe('shadowMapSizeFor', () => {
  it('halves the resolution on phones and tablets only', () => {
    expect(shadowMapSizeFor(undefined)).toBe(SHADOW_MAP_SIZE);
    expect(shadowMapSizeFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140 Safari/537.36')).toBe(SHADOW_MAP_SIZE);
    expect(shadowMapSizeFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148')).toBe(SHADOW_MAP_SIZE_MOBILE);
    expect(shadowMapSizeFor('Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/140 Mobile Safari/537.36')).toBe(SHADOW_MAP_SIZE_MOBILE);
    expect(shadowMapSizeFor('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Safari/604.1')).toBe(SHADOW_MAP_SIZE_MOBILE);
  });
});
