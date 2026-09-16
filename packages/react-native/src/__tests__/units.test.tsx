import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { EngineCommand } from '@maprama/protocol';
import { CommandBatcher, throttle } from '../batching';
import { diffCamera, toLabelsSpec } from '../MapramaView';
import { planLocation, resetExpoLocationCache, startExpoLocationWatch } from '../location/device';

describe('CommandBatcher', () => {
  function setup(ready = true) {
    const sent: EngineCommand[] = [];
    const frames: (() => void)[] = [];
    const batcher = new CommandBatcher({ sink: (c) => sent.push(c), canFlush: () => ready, schedule: (cb) => frames.push(cb) });
    const frame = () => frames.splice(0).forEach((cb) => cb());
    return { sent, batcher, frame };
  }

  it('schedules at most one flush per frame and skips unchanged specs', () => {
    const { sent, batcher, frame } = setup();
    batcher.setCharacters('a', [{ id: 'x' }]);
    batcher.setCharacters('b', [{ id: 'y', isPlayer: true }]);
    batcher.setCharacters('a', [{ id: 'x', name: 'X' }]);
    expect(batcher.getPlayerId()).toBe('y');
    frame();
    expect(sent).toEqual([{ type: 'upsertCharacters', characters: [{ id: 'x', name: 'X' }, { id: 'y', isPlayer: true }] }]);
    sent.length = 0;
    batcher.setCharacters('a', [{ id: 'x', name: 'X' }]);
    frame();
    expect(sent).toEqual([]);
  });

  it('waits while not ready and re-sends everything after resetSent', () => {
    let ready = false;
    const sent: EngineCommand[] = [];
    const frames: (() => void)[] = [];
    const batcher = new CommandBatcher({ sink: (c) => sent.push(c), canFlush: () => ready, schedule: (cb) => frames.push(cb) });
    batcher.setDropLayer('l', { drops: [], collectRadiusMeters: 10, collectorIds: ['me'] });
    frames.splice(0).forEach((cb) => cb());
    expect(sent).toEqual([]);
    ready = true;
    batcher.flushNow();
    expect(sent).toEqual([{ type: 'setDropLayer', layerId: 'l', drops: [], collectRadiusMeters: 10, collectorIds: ['me'] }]);
    batcher.flushNow();
    expect(sent).toHaveLength(1);
    batcher.resetSent();
    batcher.flushNow();
    expect(sent).toHaveLength(2);
  });

  it('dedupes label content', () => {
    const { sent, batcher, frame } = setup();
    batcher.setLabelContent({ a: { title: 'A' } });
    frame();
    batcher.setLabelContent({ a: { title: 'A' } });
    frame();
    expect(sent).toEqual([{ type: 'setLabelContent', entries: { a: { title: 'A' } } }]);
  });
});

describe('throttle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs leading and trailing calls', () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    const t = throttle(fn, 100);
    t.call(1);
    t.call(2);
    t.call(3);
    expect(fn.mock.calls).toEqual([[1]]);
    jest.advanceTimersByTime(100);
    expect(fn.mock.calls).toEqual([[1], [3]]);
    t.call(4);
    t.cancel();
    jest.advanceTimersByTime(200);
    expect(fn.mock.calls).toEqual([[1], [3]]);
  });
});

describe('prop helpers', () => {
  it('diffCamera returns only changed fields', () => {
    expect(diffCamera(undefined, undefined)).toBeNull();
    expect(diffCamera({ pitch: 45 }, { pitch: 45, animate: true })).toBeNull();
    expect(diffCamera({ pitch: 45, center: { lng: 1, lat: 2 } }, { pitch: 45, center: { lng: 1, lat: 3 } })).toEqual({ center: { lng: 1, lat: 3 } });
    expect(diffCamera({ follow: 'me', distance: 10 }, { distance: 10 })).toEqual({ follow: null });
    expect(diffCamera({ follow: null }, {})).toBeNull();
    // The metre limits are part of the declarative camera, so a prop change sends them.
    expect(diffCamera({}, { minDistanceMeters: 60, maxDistanceMeters: 3330 })).toEqual({
      minDistanceMeters: 60,
      maxDistanceMeters: 3330,
    });
    expect(diffCamera({ maxDistanceMeters: 3330 }, { maxDistanceMeters: 3330, pitch: 30 })).toEqual({ pitch: 30 });
    expect(diffCamera({ maxDistanceMeters: 3330 }, { maxDistanceMeters: 1200 })).toEqual({ maxDistanceMeters: 1200 });
  });

  it('toLabelsSpec replaces a content function with custom', () => {
    expect(toLabelsSpec(undefined)).toEqual({});
    expect(toLabelsSpec({ style: 'app', content: 'nameOnly' })).toEqual({ style: 'app', content: 'nameOnly' });
    expect(toLabelsSpec({ style: 'holo', content: (l) => ({ title: l.name }) })).toEqual({ style: 'holo', content: 'custom' });
  });
});

describe('device location', () => {
  afterEach(() => {
    resetExpoLocationCache();
    // Drop the cached mock module so the next `doMock` factory is used.
    jest.resetModules();
    try {
      jest.dontMock('expo-location');
    } catch {
      // Not installed and never mocked: nothing to undo.
    }
  });

  it('falls back to WebView geolocation without expo-location', () => {
    resetExpoLocationCache();
    expect(planLocation({ source: 'device' })).toEqual({ engineSource: 'device', useExpoLocation: false, webViewGeolocation: true });
    expect(planLocation({ source: 'simulated' })).toEqual({ engineSource: 'simulated', useExpoLocation: false, webViewGeolocation: false });
    expect(planLocation(undefined).engineSource).toBe('external');
  });

  it('uses expo-location when installed and pushes fixes', async () => {
    const remove = jest.fn();
    let callback: ((l: unknown) => void) | null = null;
    jest.doMock(
      'expo-location',
      () => ({
        Accuracy: { High: 4, BestForNavigation: 6 },
        requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
        watchPositionAsync: async (_options: unknown, cb: (l: unknown) => void) => {
          callback = cb;
          return { remove };
        },
      }),
      { virtual: true },
    );
    resetExpoLocationCache();
    expect(planLocation({ source: 'device' })).toEqual({ engineSource: 'external', useExpoLocation: true, webViewGeolocation: false });
    expect(planLocation({ source: 'device', provider: 'webview' }).engineSource).toBe('device');

    const fixes: unknown[] = [];
    const stop = startExpoLocationWatch((fix) => fixes.push(fix), () => {});
    for (let i = 0; i < 5; i++) await Promise.resolve();
    callback!({ coords: { latitude: 37.5, longitude: 127.0, accuracy: 8, heading: -1, speed: 1.2 }, timestamp: 99 });
    expect(fixes).toEqual([{ lng: 127.0, lat: 37.5, accuracyMeters: 8, speedMps: 1.2, timestamp: 99 }]);
    stop();
    expect(remove).toHaveBeenCalled();
  });

  it('reports a denied permission', async () => {
    jest.doMock(
      'expo-location',
      () => ({
        requestForegroundPermissionsAsync: async () => ({ status: 'denied' }),
        watchPositionAsync: async () => ({ remove: () => {} }),
      }),
      { virtual: true },
    );
    resetExpoLocationCache();
    const onError = jest.fn();
    startExpoLocationWatch(() => {}, onError);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('location_permission_denied', expect.any(String));
  });
});
