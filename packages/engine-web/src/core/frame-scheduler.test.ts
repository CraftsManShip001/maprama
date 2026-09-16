import { describe, expect, it } from 'vitest';
import { FrameScheduler } from './frame-scheduler.js';

describe('FrameScheduler', () => {
  it('is idle until something asks for a frame', () => {
    const s = new FrameScheduler();
    expect(s.busy).toBe(false);
    expect(s.continuous).toBe(false);
    expect(s.take()).toBe(false);
    expect(s.take()).toBe(false);
  });

  it('runs exactly one frame per request, however many times it was requested', () => {
    const s = new FrameScheduler();
    s.request();
    s.request();
    s.request();
    expect(s.take()).toBe(true);
    expect(s.take()).toBe(false);
  });

  it('a requested frame still runs one step while no source is held', () => {
    const s = new FrameScheduler();
    s.request();
    expect(s.continuous).toBe(false);
    expect(s.take()).toBe(true); // the body runs: hooks, camera update, render
    expect(s.busy).toBe(false);
  });

  it('keeps running while a source is held and goes idle once it is released', () => {
    const s = new FrameScheduler();
    const release = s.addSource('features');
    expect(s.continuous).toBe(true);
    for (let i = 0; i < 5; i++) expect(s.take()).toBe(true);
    release();
    expect(s.busy).toBe(false);
    expect(s.take()).toBe(false);
  });

  it('releasing twice does not drop another holder of the same tag', () => {
    const s = new FrameScheduler();
    const a = s.addSource('chars');
    const b = s.addSource('chars');
    expect(s.tags).toEqual(['chars']);
    a();
    a(); // idempotent: must not release b's hold
    expect(s.take()).toBe(true);
    b();
    expect(s.take()).toBe(false);
  });

  it('is idle only after every source released', () => {
    const s = new FrameScheduler();
    const a = s.addSource('drops');
    const b = s.addSource('traffic');
    expect(s.tags).toEqual(['drops', 'traffic']);
    a();
    expect(s.tags).toEqual(['traffic']);
    expect(s.take()).toBe(true);
    b();
    expect(s.tags).toEqual([]);
    expect(s.take()).toBe(false);
  });

  it('a request while a source is held does not survive the frame', () => {
    const s = new FrameScheduler();
    const release = s.addSource('camera');
    s.request();
    expect(s.take()).toBe(true);
    release();
    expect(s.take()).toBe(false);
  });
});
