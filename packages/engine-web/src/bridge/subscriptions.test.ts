import { describe, expect, it } from 'vitest';
import { OVERLAY_INTERVAL_MS, OverlayTracker, ThrottledTopic } from './subscriptions.js';

describe('ThrottledTopic', () => {
  it('throttles per subscription and key', () => {
    const t = new ThrottledTopic();
    expect(t.active).toBe(false);
    t.subscribe(undefined, 100);
    expect(t.due('a', 0)).toBe(true);
    expect(t.due('b', 10)).toBe(true); // other key is independent
    expect(t.due('a', 50)).toBe(false);
    expect(t.due('a', 99)).toBe(false);
    expect(t.due('a', 100)).toBe(true);
    expect(t.due('a', 150)).toBe(false);
  });

  it('id subscriptions only match their id; all-subscriptions match every id', () => {
    const t = new ThrottledTopic();
    t.subscribe('me', 0);
    expect(t.wants('me')).toBe(true);
    expect(t.wants('npc')).toBe(false);
    t.subscribe(undefined, 1000);
    expect(t.wants('npc')).toBe(true);
    // "me" is due through its own 0 ms subscription even when the all-subscription is throttled
    expect(t.due('me', 0)).toBe(true);
    expect(t.due('me', 1)).toBe(true);
    expect(t.due('npc', 1)).toBe(true);
    expect(t.due('npc', 2)).toBe(false);
  });

  it('resubscribing replaces the throttle; unsubscribe stops events; reset re-arms a key', () => {
    const t = new ThrottledTopic();
    t.subscribe('me', 1000);
    expect(t.due('me', 0)).toBe(true);
    expect(t.due('me', 10)).toBe(false);
    t.subscribe('me', 5);
    expect(t.due('me', 10)).toBe(true);
    t.reset('me');
    expect(t.due('me', 11)).toBe(true);
    t.unsubscribe('me');
    expect(t.active).toBe(false);
    expect(t.due('me', 5000)).toBe(false);
  });
});

describe('OverlayTracker', () => {
  const p = (x: number, visible = true) => [{ id: 'a', x, y: 10, visible }];

  it('sends immediately, then at most every 33 ms and only on change', () => {
    const o = new OverlayTracker();
    expect(OVERLAY_INTERVAL_MS).toBe(33);
    expect(o.update(p(1), 0)).not.toBeNull();
    expect(o.update(p(5), 10)).toBeNull(); // too soon
    expect(o.update(p(1), 40)).toBeNull(); // unchanged
    expect(o.update(p(2), 50)).not.toBeNull();
    expect(o.update(p(2, false), 70)).toBeNull(); // too soon, even for visibility
    expect(o.update(p(2, false), 90)).not.toBeNull();
  });

  it('never sends without anchors and resends after invalidate', () => {
    const o = new OverlayTracker();
    expect(o.update([], 0)).toBeNull();
    expect(o.update(p(1), 100)).not.toBeNull();
    expect(o.update(p(1), 200)).toBeNull();
    o.invalidate();
    expect(o.update(p(1), 300)).not.toBeNull();
  });
});
