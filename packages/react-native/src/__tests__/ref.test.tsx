import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRef, useRef } from 'react';
import { Text } from 'react-native';
import { act, render } from '@testing-library/react-native';
import type { EngineCommand, EngineEvent, EngineInfo } from '@maprama/protocol';
import {
  Character,
  MapramaError,
  MapramaView,
  useCameraState,
  useCharacterPosition,
  useMapramaView,
  type MapramaViewRef,
  type EngineHost,
} from '../index';
import { MapController } from '../ref';
import { READY, clearPosted, commands, commandsOf, emit, webViewInstances } from './helpers';

const DEST = { lng: 127.06, lat: 37.55 };

beforeEach(() => {
  webViewInstances.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

async function readyMap(extra: Partial<Parameters<typeof MapramaView>[0]> = {}) {
  const ref = createRef<MapramaViewRef>();
  const utils = await render(
    <MapramaView ref={ref} world={{ kind: 'procedural', layout: 'grid' }} {...extra}>
      <Character id="me" isPlayer />
    </MapramaView>,
  );
  await emit(READY);
  clearPosted();
  return { ref, ...utils };
}

describe('travel', () => {
  it('resolves on travel:arrive with the started legs', async () => {
    const { ref } = await readyMap();
    let result: unknown;
    let promise!: Promise<unknown>;
    await act(async () => {
      promise = ref.current!.travel('me', DEST, ['walk', 'car', 'walk']).then((r) => (result = r));
    });
    const [travel] = commandsOf('travel');
    expect(travel).toEqual({ type: 'travel', requestId: expect.any(String), characterId: 'me', to: DEST, modes: ['walk', 'car', 'walk'] });
    const legs = [
      { mode: 'walk' as const, meters: 120 },
      { mode: 'car' as const, meters: 900 },
      { mode: 'walk' as const, meters: 40 },
    ];
    await emit({ type: 'travel:start', requestId: travel!.requestId, characterId: 'me', legs });
    expect(result).toBeUndefined();
    await emit({ type: 'travel:arrive', requestId: travel!.requestId, characterId: 'me' });
    await act(async () => {
      await promise;
    });
    expect(result).toEqual({ requestId: travel!.requestId, characterId: 'me', legs });
  });

  it('omits timeScale by default (real-world speed) and when it is 1', async () => {
    const { ref } = await readyMap();
    await act(async () => {
      void ref.current!.travel('me', DEST).catch(() => {});
      void ref.current!.travel('me', DEST, 'walk', { timeScale: 1 }).catch(() => {});
    });
    const sent = commandsOf('travel');
    expect(sent).toHaveLength(2);
    for (const cmd of sent) expect('timeScale' in cmd).toBe(false);
  });

  it('sends the map default travelTimeScale and lets a call override it', async () => {
    const { ref } = await readyMap({ travelTimeScale: 20 });
    await act(async () => {
      void ref.current!.travel('me', DEST, 'walk').catch(() => {});
      void ref.current!.travel('me', DEST, 'walk', { timeScale: 5 }).catch(() => {});
      void ref.current!.travel('me', DEST, 'walk', { timeScale: 1 }).catch(() => {});
    });
    const sent = commandsOf('travel');
    expect(sent.map((c) => c.timeScale)).toEqual([20, 5, undefined]);
    expect(sent[0]).toEqual({ type: 'travel', requestId: expect.any(String), characterId: 'me', to: DEST, modes: ['walk'], timeScale: 20 });
    expect('timeScale' in sent[2]!).toBe(false);
  });

  it('rejects an invalid timeScale with invalid_argument before sending anything', async () => {
    const { ref } = await readyMap();
    for (const timeScale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2' as unknown as number]) {
      await expect(ref.current!.travel('me', DEST, 'walk', { timeScale })).rejects.toMatchObject({
        name: 'MapramaError',
        code: 'invalid_argument',
        message: expect.stringContaining('options.timeScale'),
      });
    }
    expect(commandsOf('travel')).toEqual([]);
  });

  it('rejects when the map default travelTimeScale is invalid unless the call overrides it', async () => {
    const { ref } = await readyMap({ travelTimeScale: 0 });
    await expect(ref.current!.travel('me', DEST)).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('travelTimeScale') });
    expect(commandsOf('travel')).toEqual([]);
    await act(async () => {
      void ref.current!.travel('me', DEST, 'walk', { timeScale: 2 }).catch(() => {});
    });
    expect(commandsOf('travel').map((c) => c.timeScale)).toEqual([2]);
  });

  it('rejects on travel:cancel', async () => {
    const { ref } = await readyMap();
    let promise!: Promise<unknown>;
    await act(async () => {
      promise = ref.current!.travel('me', DEST, 'walk');
      promise.catch(() => {});
    });
    const [travel] = commandsOf('travel');
    expect(travel!.modes).toEqual(['walk']);
    await emit({ type: 'travel:cancel', requestId: travel!.requestId, characterId: 'me' });
    await expect(promise).rejects.toMatchObject({ name: 'MapramaError', code: 'travel_cancelled' });
  });

  it('rejects with timeout when travel does not start and cancels it', async () => {
    jest.useFakeTimers();
    const { ref } = await readyMap({ travelStartTimeoutMs: 1000 });
    const promise = ref.current!.travel('me', DEST);
    promise.catch(() => {});
    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    await expect(promise).rejects.toBeInstanceOf(MapramaError);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
    expect(commands().map((c) => c.type)).toEqual(['travel', 'cancelTravel']);
  });

  it('rejects with timeout when the overall travel timeout elapses', async () => {
    jest.useFakeTimers();
    const { ref } = await readyMap();
    const promise = ref.current!.travel('me', DEST, ['walk'], { timeoutMs: 5000 });
    promise.catch(() => {});
    const [travel] = commandsOf('travel');
    await emit({ type: 'travel:start', requestId: travel!.requestId, characterId: 'me', legs: [] });
    await act(async () => {
      jest.advanceTimersByTime(5001);
    });
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
  });

  it('restarts the start timeout when a queued travel reaches the engine', async () => {
    jest.useFakeTimers();
    const ref = createRef<MapramaViewRef>();
    await render(<MapramaView ref={ref} world={{ kind: 'procedural', layout: 'grid' }} travelStartTimeoutMs={1000} />);
    const promise = ref.current!.travel('me', DEST);
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await act(async () => {
      jest.advanceTimersByTime(900);
    });
    expect(settled).toBe(false);
    await emit(READY);
    await act(async () => {
      jest.advanceTimersByTime(900);
    });
    // 1800 ms after the call, but only 900 ms after delivery.
    expect(settled).toBe(false);
    await act(async () => {
      jest.advanceTimersByTime(101);
    });
    expect(settled).toBe(true);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects a travel made before ready when the engine never becomes ready, and drops the queued command', async () => {
    jest.useFakeTimers();
    const ref = createRef<MapramaViewRef>();
    await render(<MapramaView ref={ref} world={{ kind: 'procedural', layout: 'grid' }} travelStartTimeoutMs={1000} />);
    const promise = ref.current!.travel('me', DEST);
    promise.catch(() => {});
    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    await expect(promise).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('not ready') });
    await emit(READY);
    expect(commands().map((c) => c.type)).toEqual(['init']);
  });

  it('rejects pending operations with unmounted on unmount', async () => {
    const { ref, unmount } = await readyMap();
    const api = ref.current!;
    const promise = api.travel('me', DEST);
    const request = api.project(DEST);
    promise.catch(() => {});
    request.catch(() => {});
    await unmount();
    await expect(promise).rejects.toMatchObject({ code: 'unmounted' });
    await expect(request).rejects.toMatchObject({ code: 'unmounted' });
  });
});

describe('requests', () => {
  it('correlates project() responses by requestId', async () => {
    const { ref } = await readyMap();
    const a = ref.current!.project(DEST);
    const b = ref.current!.project({ lng: 127, lat: 37 });
    const [ra, rb] = commandsOf('request');
    expect(ra).toEqual({ type: 'request', requestId: expect.any(String), method: 'project', params: { coordinate: DEST } });
    await emit({ type: 'response', requestId: rb!.requestId, ok: true, result: { x: 1, y: 2, visible: false } });
    await emit({ type: 'response', requestId: ra!.requestId, ok: true, result: { x: 10, y: 20, visible: true } });
    await expect(a).resolves.toEqual({ x: 10, y: 20, visible: true });
    await expect(b).resolves.toEqual({ x: 1, y: 2, visible: false });
  });

  it('rejects failed responses with the normalised code', async () => {
    const { ref } = await readyMap();
    const unproject = ref.current!.unproject({ x: 5, y: 5 });
    unproject.catch(() => {});
    const snap = ref.current!.snapToRoad(DEST, 30);
    const [ru, rs] = commandsOf('request');
    expect(rs!.params).toEqual({ coordinate: DEST, maxDistanceMeters: 30 });
    await emit({ type: 'response', requestId: ru!.requestId, ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'nope' } });
    await emit({ type: 'response', requestId: rs!.requestId, ok: true, result: null });
    await expect(unproject).rejects.toMatchObject({ code: 'unsupported', message: 'nope' });
    await expect(snap).resolves.toBeNull();
  });

  it('times out', async () => {
    jest.useFakeTimers();
    const { ref } = await readyMap({ requestTimeoutMs: 200 });
    const route = ref.current!.route(DEST, { lng: 127, lat: 37 }, ['walk']);
    route.catch(() => {});
    await act(async () => {
      jest.advanceTimersByTime(201);
    });
    await expect(route).rejects.toMatchObject({ code: 'timeout' });
  });

  it('arms a not-ready timeout at the call when the engine never becomes ready', async () => {
    jest.useFakeTimers();
    const ref = createRef<MapramaViewRef>();
    await render(<MapramaView ref={ref} world={{ kind: 'procedural', layout: 'grid' }} requestTimeoutMs={300} />);
    const point = ref.current!.project(DEST);
    point.catch(() => {});
    await act(async () => {
      jest.advanceTimersByTime(299);
    });
    expect(commands()).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(2);
    });
    await expect(point).rejects.toMatchObject({ name: 'MapramaError', code: 'timeout', message: expect.stringContaining('not ready') });
    // A late ready does not deliver the abandoned request.
    await emit(READY);
    expect(commands().map((c) => c.type)).toEqual(['init']);
  });

  it('rejects pending requests and travel with the host code on a fatal host load error', async () => {
    const onError = jest.fn();
    const ref = createRef<MapramaViewRef>();
    await render(<MapramaView ref={ref} world={{ kind: 'procedural', layout: 'grid' }} onError={onError} />);
    const point = ref.current!.project(DEST);
    const trip = ref.current!.travel('me', DEST);
    point.catch(() => {});
    trip.catch(() => {});
    const webView = webViewInstances[webViewInstances.length - 1]!;
    await act(async () => {
      (webView.props.onError as (e: { nativeEvent: { description: string } }) => void)({ nativeEvent: { description: 'net::ERR_FAILED' } });
    });
    await expect(point).rejects.toMatchObject({ name: 'MapramaError', code: 'host_load_failed' });
    await expect(trip).rejects.toMatchObject({ name: 'MapramaError', code: 'host_load_failed' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'host_load_failed', fatal: true }));
    await emit(READY);
    expect(commands().map((c) => c.type)).toEqual(['init']);
  });

  it('rejects pending work on any fatal host error (e.g. no engine host registered), not on non-fatal ones', async () => {
    const onError = jest.fn();
    const api = new MapController({
      buildInit: () => ({ type: 'init', world: { kind: 'procedural', layout: 'grid' }, theme: {}, labels: {}, ui: {}, locationSource: 'external' }),
      onError,
    });
    const pending = api.project(DEST);
    pending.catch(() => {});
    api.reportHostError({ code: 'host_crashed', message: 'reloading', fatal: false });
    api.reportHostError({ code: 'unsupported', message: 'no engine host registered for "x"', fatal: true });
    await expect(pending).rejects.toMatchObject({ name: 'MapramaError', code: 'unsupported' });
    expect(onError.mock.calls.map(([e]) => (e as { code: string }).code)).toEqual(['host_crashed', 'unsupported']);
    api.dispose();
  });

  it('reads requestTimeoutMs and travelStartTimeoutMs from the latest props', async () => {
    jest.useFakeTimers();
    const ref = createRef<MapramaViewRef>();
    const tree = (requestTimeoutMs: number, travelStartTimeoutMs: number) => (
      <MapramaView ref={ref} world={{ kind: 'procedural', layout: 'grid' }} requestTimeoutMs={requestTimeoutMs} travelStartTimeoutMs={travelStartTimeoutMs}>
        <Character id="me" isPlayer />
      </MapramaView>
    );
    const { rerender } = await render(tree(60000, 60000));
    await emit(READY);
    await rerender(tree(200, 300));
    const route = ref.current!.route(DEST, { lng: 127, lat: 37 });
    const trip = ref.current!.travel('me', DEST);
    route.catch(() => {});
    trip.catch(() => {});
    await act(async () => {
      jest.advanceTimersByTime(201);
    });
    await expect(route).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('200 ms') });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await expect(trip).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('300 ms') });
  });
});

describe('subscriptions', () => {
  it('useCharacterPosition subscribes with throttle and unsubscribes on unmount', async () => {
    jest.useFakeTimers();
    const renders: string[] = [];
    function Hud({ showPosition }: { showPosition: boolean }) {
      const map = useRef<MapramaViewRef>(null);
      return (
        <>
          <MapramaView ref={map} world={{ kind: 'procedural', layout: 'town' }}>
            <Character id="me" isPlayer />
          </MapramaView>
          {showPosition ? <Position map={map} /> : null}
        </>
      );
    }
    function Position({ map }: { map: { current: MapramaViewRef | null } }) {
      const pos = useCharacterPosition(map, 'me', { throttleMs: 500 });
      const label = pos ? `${pos.coordinate.lng},${pos.coordinate.lat}` : 'none';
      renders.push(label);
      return <Text testID="pos">{label}</Text>;
    }
    const { getByTestId, rerender } = await render(<Hud showPosition />);
    await emit(READY);
    expect(commandsOf('subscribe')).toEqual([{ type: 'subscribe', topic: 'character:position', id: 'me', throttleMs: 500 }]);

    const position = (lng: number): EngineEvent => ({ type: 'character:position', id: 'me', coordinate: { lng, lat: 37 }, headingDeg: 0, speedMps: 1 });
    await emit(position(127.001));
    expect(getByTestId('pos').props.children).toBe('127.001,37');
    await emit(position(127.002));
    await emit(position(127.003));
    await emit({ type: 'character:position', id: 'other', coordinate: { lng: 1, lat: 1 }, headingDeg: 0, speedMps: 0 });
    expect(getByTestId('pos').props.children).toBe('127.001,37');
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    // Trailing update with the latest value only.
    expect(getByTestId('pos').props.children).toBe('127.003,37');
    expect(renders).not.toContain('127.002,37');

    clearPosted();
    await rerender(<Hud showPosition={false} />);
    expect(webViewInstances).toHaveLength(1);
    expect(commands().filter((c) => c.type === 'unsubscribe')).toEqual([{ type: 'unsubscribe', topic: 'character:position', id: 'me' }]);
  });

  it('useCameraState works inside the map via context and useMapramaView exposes the ref API', async () => {
    let api: MapramaViewRef | null = null;
    function Inside() {
      api = useMapramaView();
      const camera = useCameraState(null, { throttleMs: 0 });
      return <Text testID="cam">{camera ? String(camera.distance) : 'none'}</Text>;
    }
    const ref = createRef<MapramaViewRef>();
    const { getByTestId } = await render(
      <MapramaView ref={ref} world={{ kind: 'procedural', layout: 'town' }}>
        <Inside />
      </MapramaView>,
    );
    expect(api).toBe(ref.current);
    await emit(READY);
    expect(commandsOf('subscribe')).toEqual([{ type: 'subscribe', topic: 'camera:change', throttleMs: 0 }]);
    await emit({ type: 'camera:change', camera: { center: DEST, distance: 42, pitch: 45, bearing: 0 } });
    expect(getByTestId('cam').props.children).toBe('42');
  });

  it('hooks holding a ref subscribe once a conditionally rendered map mounts, and follow a remounted map', async () => {
    function App({ showMap, mapKey = 'a' }: { showMap: boolean; mapKey?: string }) {
      const map = useRef<MapramaViewRef>(null);
      const pos = useCharacterPosition(map, 'me', { throttleMs: 0 });
      const camera = useCameraState(map, { throttleMs: 0 });
      return (
        <>
          <Text testID="pos">{pos ? String(pos.coordinate.lng) : 'none'}</Text>
          <Text testID="cam">{camera ? String(camera.distance) : 'none'}</Text>
          {showMap ? <MapramaView key={mapKey} ref={map} world={{ kind: 'procedural', layout: 'town' }} /> : null}
        </>
      );
    }
    const { getByTestId, rerender } = await render(<App showMap={false} />);
    expect(webViewInstances).toHaveLength(0);

    await rerender(<App showMap />);
    await emit(READY);
    const expected = [
      { type: 'subscribe', topic: 'character:position', id: 'me', throttleMs: 0 },
      { type: 'subscribe', topic: 'camera:change', throttleMs: 0 },
    ];
    expect(commandsOf('subscribe')).toEqual(expect.arrayContaining(expected));
    await emit({ type: 'character:position', id: 'me', coordinate: { lng: 127.5, lat: 37 }, headingDeg: 0, speedMps: 1 });
    await emit({ type: 'camera:change', camera: { center: DEST, distance: 33, pitch: 45, bearing: 0 } });
    expect(getByTestId('pos').props.children).toBe('127.5');
    expect(getByTestId('cam').props.children).toBe('33');

    // The previous map's values are not shown once the map is gone, nor for a remounted map before it reports.
    await rerender(<App showMap={false} />);
    expect(getByTestId('pos').props.children).toBe('none');
    expect(getByTestId('cam').props.children).toBe('none');
    await rerender(<App showMap />);
    expect(webViewInstances).toHaveLength(2);
    expect(getByTestId('pos').props.children).toBe('none');
    expect(getByTestId('cam').props.children).toBe('none');
    await emit(READY);
    expect(commandsOf('subscribe')).toEqual(expect.arrayContaining(expected));
    await emit({ type: 'character:position', id: 'me', coordinate: { lng: 127.25, lat: 37 }, headingDeg: 0, speedMps: 1 });
    await emit({ type: 'camera:change', camera: { center: DEST, distance: 44, pitch: 45, bearing: 0 } });
    expect(getByTestId('pos').props.children).toBe('127.25');
    expect(getByTestId('cam').props.children).toBe('44');
  });

  it('hooks reset to null when the map is swapped directly for another map', async () => {
    function App({ mapKey }: { mapKey: string }) {
      const map = useRef<MapramaViewRef>(null);
      const pos = useCharacterPosition(map, 'me', { throttleMs: 0 });
      const camera = useCameraState(map, { throttleMs: 0 });
      return (
        <>
          <Text testID="pos">{pos ? String(pos.coordinate.lng) : 'none'}</Text>
          <Text testID="cam">{camera ? String(camera.distance) : 'none'}</Text>
          <MapramaView key={mapKey} ref={map} world={{ kind: 'procedural', layout: 'town' }} />
        </>
      );
    }
    const { getByTestId, rerender } = await render(<App mapKey="a" />);
    await emit(READY);
    await emit({ type: 'character:position', id: 'me', coordinate: { lng: 127.5, lat: 37 }, headingDeg: 0, speedMps: 1 });
    await emit({ type: 'camera:change', camera: { center: DEST, distance: 33, pitch: 45, bearing: 0 } });
    expect(getByTestId('pos').props.children).toBe('127.5');
    expect(getByTestId('cam').props.children).toBe('33');

    // Unmount of map "a" and mount of map "b" happen in one commit.
    await rerender(<App mapKey="b" />);
    expect(webViewInstances).toHaveLength(2);
    expect(getByTestId('pos').props.children).toBe('none');
    expect(getByTestId('cam').props.children).toBe('none');
    await emit(READY);
    await emit({ type: 'character:position', id: 'me', coordinate: { lng: 127.75, lat: 37 }, headingDeg: 0, speedMps: 1 });
    expect(getByTestId('pos').props.children).toBe('127.75');
    expect(getByTestId('cam').props.children).toBe('none');
  });
});

describe('MapController (host-level)', () => {
  function fakeHost() {
    const sent: EngineCommand[] = [];
    let listener: ((event: EngineEvent) => void) | null = null;
    const host: EngineHost = {
      kind: 'fake',
      ready: new Promise<EngineInfo>(() => {}),
      send: (command) => sent.push(command),
      onEvent: (l) => {
        listener = l;
        return () => (listener = null);
      },
      destroy: () => {},
    };
    return { host, sent, emit: (event: EngineEvent) => listener?.(event) };
  }

  it('shares one engine subscription between listeners and uses the smallest throttle', () => {
    const { host, sent, emit: send } = fakeHost();
    const controller = new MapController({ buildInit: () => ({ type: 'init', world: { kind: 'procedural', layout: 'grid' }, theme: {}, labels: {}, ui: {}, locationSource: 'external' }) });
    controller.attachHost(host);
    send(READY);
    sent.length = 0;
    const a = jest.fn();
    const b = jest.fn();
    const offA = controller.subscribe('travel:progress', a, { id: 'me', throttleMs: 1000 });
    const offB = controller.subscribe('travel:progress', b, { id: 'me', throttleMs: 0 });
    expect(sent).toEqual([
      { type: 'subscribe', topic: 'travel:progress', id: 'me', throttleMs: 1000 },
      { type: 'subscribe', topic: 'travel:progress', id: 'me', throttleMs: 0 },
    ]);
    send({ type: 'travel:progress', requestId: 'r', characterId: 'me', remainingMeters: 10, etaSeconds: 5, mode: 'walk' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    sent.length = 0;
    offB();
    expect(sent).toEqual([{ type: 'subscribe', topic: 'travel:progress', id: 'me', throttleMs: 1000 }]);
    offA();
    offA();
    expect(sent).toEqual([
      { type: 'subscribe', topic: 'travel:progress', id: 'me', throttleMs: 1000 },
      { type: 'unsubscribe', topic: 'travel:progress', id: 'me' },
    ]);
    controller.dispose();
  });

  it('keeps only the newest queued pushLocation before ready', () => {
    const { host, sent, emit: send } = fakeHost();
    const controller = new MapController({ buildInit: () => ({ type: 'init', world: { kind: 'procedural', layout: 'grid' }, theme: {}, labels: {}, ui: {}, locationSource: 'external' }) });
    controller.attachHost(host);
    controller.pushLocation({ lng: 1, lat: 1, timestamp: 1 });
    controller.setCamera({ pitch: 10 });
    controller.pushLocation({ lng: 2, lat: 2, timestamp: 2 });
    send(READY);
    expect(sent.map((c) => c.type)).toEqual(['init', 'setCamera', 'pushLocation']);
    expect(sent[2]).toEqual({ type: 'pushLocation', fix: { lng: 2, lat: 2, timestamp: 2 } });
    expect(controller.getLastFix()).toEqual({ lng: 2, lat: 2, timestamp: 2 });
  });
});
