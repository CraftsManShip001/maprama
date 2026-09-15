import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import type { DropSpec, EngineEvent, LngLat } from '@maprama/protocol';
import { Character, MapramaView, DropLayer, shouldRestoreRejectedDrop, type MapramaViewProps, type ServiceDropLayerProps } from '../index';
import { MAX_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS, NearbyDropsTracker, isRetryableFetchError } from '../components/DropLayer';
import { DropsServiceError, fetchNearbyDrops, parseRetryAfterMs, verifyDropCollect } from '../service/drops';
import { READY, clearPosted, commands, commandsOf, emit, flushPromises, nextFrame, webViewInstances } from './helpers';

const WORLD = { kind: 'procedural', layout: 'town' } as const;
const HOME = { lng: 127.056, lat: 37.544 };
/** Positions within 150 m of HOME. */
const SMALL_MOVES: LngLat[] = [
  { lng: 127.0561, lat: 37.5441 },
  { lng: 127.0563, lat: 37.5442 },
  { lng: 127.0565, lat: 37.5442 },
];
/** More than 1 km from HOME. */
const FAR = { lng: 127.07, lat: 37.55 };

type FetchCall = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function mockFetch(handler: (call: FetchCall) => Reply | Promise<Reply>) {
  const calls: FetchCall[] = [];
  const fn = jest.fn(async (url: string, init: FetchCall['init']) => {
    const call = { url, init };
    calls.push(call);
    const { status, body, headers = {} } = await handler(call);
    const get = (name: string): string | null =>
      Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
    return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get } };
  });
  (globalThis as { fetch?: unknown }).fetch = fn;
  return calls;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const nearbyReply = (drops: DropSpec[], expiresAt: number | null = null): Reply => ({
  status: 200,
  body: { drops, generatedAt: 1, expiresAt },
});

const nearbyCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes('/v1/drops/nearby'));

const unavailable = (): Reply => ({ status: 503, body: { error: { code: 'UNAVAILABLE', message: 'down' } } });

/** Advances fake timers inside act and settles the promises the timers started. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flushPromises();
}

/** A position `i` steps (about 4.4 m each) east of HOME; 30 steps stay within 150 m. */
const walk = (i: number): LngLat => ({ lng: HOME.lng + i * 0.00005, lat: HOME.lat });

const lastLayerDrops = () => commandsOf('setDropLayer').at(-1)?.drops;

const originalFetch = (globalThis as { fetch?: unknown }).fetch;

beforeEach(() => {
  webViewInstances.length = 0;
});

afterEach(() => {
  (globalThis as { fetch?: unknown }).fetch = originalFetch;
  jest.useRealTimers();
});

describe('DropLayer source="data"', () => {
  type Track = { id: string; coord: { lng: number; lat: number }; rarity: 'common' | 'rare' };

  it('sends resolved specs with setDropLayer and passes payloads to onCollect', async () => {
    const tracks: Track[] = [
      { id: 't1', coord: HOME, rarity: 'rare' },
      { id: 't2', coord: { lng: 127.05, lat: 37.54 }, rarity: 'common' },
    ];
    const onCollect = jest.fn();
    const tree = (data: Track[]) => (
      <MapramaView world={WORLD}>
        <DropLayer
          id="music"
          data={data}
          getId={(t) => t.id}
          getCoordinate={(t) => t.coord}
          getType={() => 'cd'}
          getRarity={(t) => t.rarity}
          getPayload={(t) => ({ trackId: t.id })}
          collectRadiusMeters={15}
          onCollect={onCollect}
        />
      </MapramaView>
    );
    const { rerender, unmount } = await render(tree(tracks));
    await emit(READY);
    await nextFrame();
    expect(commandsOf('setDropLayer')).toEqual([
      {
        type: 'setDropLayer',
        layerId: 'music',
        collectRadiusMeters: 15,
        drops: [
          { id: 't1', type: 'cd', coordinate: HOME, rarity: 'rare', payload: { trackId: 't1' } },
          { id: 't2', type: 'cd', coordinate: { lng: 127.05, lat: 37.54 }, rarity: 'common', payload: { trackId: 't2' } },
        ],
      },
    ]);

    await emit({ type: 'drop:collect', layerId: 'music', dropId: 't2', characterId: 'me', coordinate: HOME, collectId: 'col-12345678' });
    await emit({ type: 'drop:collect', layerId: 'other', dropId: 't1', characterId: 'me', coordinate: HOME, collectId: 'col-87654321' });
    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(onCollect).toHaveBeenCalledWith({
      layerId: 'music',
      dropId: 't2',
      characterId: 'me',
      coordinate: HOME,
      collectId: 'col-12345678',
      payload: { trackId: 't2' },
    });

    clearPosted();
    await rerender(tree(tracks.slice(0, 1)));
    await nextFrame();
    expect(commandsOf('setDropLayer')).toHaveLength(1);
    expect(commandsOf('setDropLayer')[0]!.drops.map((d) => d.id)).toEqual(['t1']);

    clearPosted();
    await rerender(<MapramaView world={WORLD} />);
    await nextFrame();
    expect(commands()).toEqual([{ type: 'removeDropLayer', layerId: 'music' }]);
    await unmount();
  });
});

describe('DropLayer source="service"', () => {
  const SERVICE_DROPS: DropSpec[] = [
    { id: 'd1.c1.1.wydm9q.0', type: 'coin', coordinate: HOME, rarity: 'common', value: 5, payload: { coins: 5 } },
    { id: 'd1.c1.1.wydm9q.1', type: 'vinyl', coordinate: { lng: 127.057, lat: 37.545 }, rarity: 'legendary' },
  ];
  const FAR_DROPS: DropSpec[] = [{ id: 'd1.c1.1.far.0', type: 'coin', coordinate: FAR }];

  const position = (coordinate: LngLat): EngineEvent => ({
    type: 'character:position',
    id: 'me',
    coordinate,
    headingDeg: 0,
    speedMps: 1,
  });

  function renderLayer(layer: Omit<Partial<ServiceDropLayerProps>, 'source'> = {}, map: Partial<MapramaViewProps> = {}) {
    return render(layerTree(layer, map));
  }

  function layerTree(layer: Omit<Partial<ServiceDropLayerProps>, 'source'> = {}, map: Partial<MapramaViewProps> = {}) {
    return (
      <MapramaView world={WORLD} {...map}>
        <Character id="me" isPlayer follow="location" />
        <DropLayer
          id="coins"
          source="service"
          channel="coins"
          apiKey="client-key"
          baseUrl="https://api.example/"
          userId="u1"
          positionThrottleMs={0}
          {...layer}
        />
      </MapramaView>
    );
  }

  async function readyWithPosition(at: LngLat = HOME) {
    await emit(READY);
    await emit(position(at));
    await flushPromises();
  }

  it('fetches nearby drops around the player, refetches after moving, and verifies collections', async () => {
    const calls = mockFetch(({ url, init }) => {
      if (url.includes('/v1/drops/nearby')) return nearbyReply(SERVICE_DROPS);
      const body = JSON.parse(init.body!) as { dropId: string };
      if (body.dropId === SERVICE_DROPS[0]!.id) {
        return { status: 200, body: { receipt: 'rcpt.sig', replayed: false, collect: { dropId: body.dropId, collectId: 'x', userId: 'u1', collectedAt: 5 } } };
      }
      return { status: 422, body: { error: { code: 'TOO_FAR', message: 'Fix is 55 m from the drop (allowed 50 m)' } } };
    });
    const onCollect = jest.fn();
    const onCollectVerified = jest.fn();
    const onCollectRejected = jest.fn();

    await renderLayer({ radiusMeters: 300, onCollect, onCollectVerified, onCollectRejected });
    await emit(READY);
    expect(commandsOf('subscribe')).toEqual([{ type: 'subscribe', topic: 'character:position', id: 'me', throttleMs: 0 }]);
    expect(calls).toHaveLength(0);

    await emit(position(HOME));
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example/v1/drops/nearby?lng=127.056&lat=37.544&radius=300&channel=coins');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer client-key');
    await nextFrame();
    // The layer is registered empty at init, then filled by the fetch.
    expect(commandsOf('setDropLayer')).toEqual([
      { type: 'setDropLayer', layerId: 'coins', collectRadiusMeters: 15, drops: [] },
      { type: 'setDropLayer', layerId: 'coins', collectRadiusMeters: 15, drops: SERVICE_DROPS },
    ]);

    // Collect: verified.
    await emit({ type: 'drop:collect', layerId: 'coins', dropId: SERVICE_DROPS[0]!.id, characterId: 'me', coordinate: HOME, collectId: 'collect-0001' });
    await flushPromises();
    expect(onCollect).toHaveBeenCalledWith(expect.objectContaining({ dropId: SERVICE_DROPS[0]!.id, payload: { coins: 5 } }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://api.example/v1/drops/collect');
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(calls[1]!.init.body!)).toEqual({
      dropId: SERVICE_DROPS[0]!.id,
      collectId: 'collect-0001',
      userId: 'u1',
      fix: { lng: HOME.lng, lat: HOME.lat, accuracyMeters: 0, timestamp: expect.any(Number) },
    });
    expect(onCollectVerified).toHaveBeenCalledWith(
      expect.objectContaining({ layerId: 'coins', dropId: SERVICE_DROPS[0]!.id, collectId: 'collect-0001', receipt: 'rcpt.sig', replayed: false }),
    );

    // Collect: rejected with the service code.
    await emit({ type: 'drop:collect', layerId: 'coins', dropId: SERVICE_DROPS[1]!.id, characterId: 'me', coordinate: HOME, collectId: 'collect-0002' });
    await flushPromises();
    expect(onCollectRejected).toHaveBeenCalledWith(
      expect.objectContaining({ dropId: SERVICE_DROPS[1]!.id, code: 'TOO_FAR', status: 422, message: 'Fix is 55 m from the drop (allowed 50 m)' }),
    );

    // Small move: no refetch. Large move (> 150 m): refetch.
    clearPosted();
    await emit(position(SMALL_MOVES[2]!));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);
    await emit(position(FAR));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(2);
    await nextFrame();
    // The verified drop stays hidden after a refetch; the TOO_FAR one is back.
    expect(lastLayerDrops()).toEqual([SERVICE_DROPS[1]]);
  });

  it('(a) keeps a slow nearby fetch alive across small position updates', async () => {
    const pending: Deferred<Reply>[] = [];
    const calls = mockFetch(() => {
      const reply = deferred<Reply>();
      pending.push(reply);
      return reply.promise;
    });
    const onError = jest.fn();
    await renderLayer({}, { onError });
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);

    for (const at of SMALL_MOVES) await emit(position(at));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);

    await act(async () => {
      pending[0]!.resolve(nearbyReply(SERVICE_DROPS));
    });
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
    expect(nearbyCalls(calls)).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('(b) refetches when the drop window expires, also after a small move', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const calls = mockFetch(() => nearbyReply(SERVICE_DROPS, Date.now() + 60_000));
    await renderLayer();
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);

    await emit(position(SMALL_MOVES[2]!));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(59_000);
    });
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(1_100);
    });
    await flushPromises();
    const nearby = nearbyCalls(calls);
    expect(nearby).toHaveLength(2);
    // Fetched around the latest position.
    expect(nearby[1]!.url).toContain(`lng=${SMALL_MOVES[2]!.lng}`);
  });

  it('(c) ignores a superseded response that resolves after the newer one', async () => {
    const pending: Deferred<Reply>[] = [];
    const calls = mockFetch(() => {
      const reply = deferred<Reply>();
      pending.push(reply);
      return reply.promise;
    });
    await renderLayer();
    await readyWithPosition();
    await emit(position(FAR));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(2);

    await act(async () => {
      pending[1]!.resolve(nearbyReply(FAR_DROPS));
    });
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(FAR_DROPS);
    const sent = commandsOf('setDropLayer').length;

    await act(async () => {
      pending[0]!.resolve(nearbyReply(SERVICE_DROPS));
    });
    await flushPromises();
    await nextFrame();
    expect(commandsOf('setDropLayer')).toHaveLength(sent);
    expect(lastLayerDrops()).toEqual(FAR_DROPS);
  });

  it('(c) applies an older response while the newer one is still in flight, then replaces it', async () => {
    const pending: Deferred<Reply>[] = [];
    mockFetch(() => {
      const reply = deferred<Reply>();
      pending.push(reply);
      return reply.promise;
    });
    await renderLayer();
    await readyWithPosition();
    await emit(position(FAR));
    await flushPromises();

    await act(async () => {
      pending[0]!.resolve(nearbyReply(SERVICE_DROPS));
    });
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);

    await act(async () => {
      pending[1]!.resolve(nearbyReply(FAR_DROPS));
    });
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(FAR_DROPS);
  });

  it('(d) reports a failed nearby fetch through onError and retries with backoff', async () => {
    jest.useFakeTimers();
    let failuresLeft = 2;
    const calls = mockFetch(() =>
      failuresLeft-- > 0 ? { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'down' } } } : nearbyReply(SERVICE_DROPS),
    );
    const onError = jest.fn();
    await renderLayer({}, { onError });
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'drops_fetch_failed', fatal: false, message: expect.stringContaining('UNAVAILABLE') }),
    );
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('retrying in 2000 ms') }));

    // A small move while the retry is pending does not bypass the backoff.
    await emit(position(SMALL_MOVES[0]!));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(1999);
    });
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(2);
    expect(nearbyCalls(calls)[1]!.url).toContain(`lng=${SMALL_MOVES[0]!.lng}`);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('retrying in 5000 ms') }));

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(3);
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  const expectLastError = (onError: jest.Mock, text: string) =>
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'drops_fetch_failed', message: expect.stringContaining(text) }));

  /** Fetch #1 succeeds with a 10 s window, every later fetch fails with 503; returns after the failed window refetch. */
  async function failedWindowRefetch() {
    jest.useFakeTimers({ now: 1_000_000 });
    let first = true;
    const calls = mockFetch(() => {
      if (!first) return unavailable();
      first = false;
      return nearbyReply(SERVICE_DROPS, Date.now() + 10_000);
    });
    const onError = jest.fn();
    await renderLayer({}, { onError });
    await readyWithPosition();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
    expect(nearbyCalls(calls)).toHaveLength(1);
    // The window timer fires at expiresAt + 50 ms; that refetch fails.
    await advance(10_049);
    expect(nearbyCalls(calls)).toHaveLength(1);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expectLastError(onError, 'retrying in 2000 ms');
    return { calls, onError };
  }

  it('(e) keeps the 2 s / 5 s / 15 s backoff after a failed window refetch while the player keeps moving', async () => {
    const { calls, onError } = await failedWindowRefetch();

    // 10 small position updates within 1.9 s: the stale window must not count as expired.
    for (let i = 1; i <= 10; i++) {
      await emit(position(walk(i)));
      await advance(190);
    }
    expect(nearbyCalls(calls)).toHaveLength(2);
    await advance(99); // 1999 ms after the failure
    expect(nearbyCalls(calls)).toHaveLength(2);
    await advance(1); // 2000 ms
    expect(nearbyCalls(calls)).toHaveLength(3);
    expect(nearbyCalls(calls)[2]!.url).toContain(`lng=${walk(10).lng}`);
    expectLastError(onError, 'retrying in 5000 ms');

    for (let i = 11; i <= 14; i++) {
      await emit(position(walk(i)));
      await advance(1000);
    }
    expect(nearbyCalls(calls)).toHaveLength(3);
    await advance(999); // 4999 ms
    expect(nearbyCalls(calls)).toHaveLength(3);
    await advance(1); // 5000 ms
    expect(nearbyCalls(calls)).toHaveLength(4);
    expectLastError(onError, 'retrying in 15000 ms');

    for (let i = 15; i <= 20; i++) {
      await emit(position(walk(i)));
      await advance(2000);
    }
    expect(nearbyCalls(calls)).toHaveLength(4);
    await advance(2999); // 14999 ms
    expect(nearbyCalls(calls)).toHaveLength(4);
    await advance(1); // 15000 ms
    expect(nearbyCalls(calls)).toHaveLength(5);
    expect(onError).toHaveBeenCalledTimes(4);
  });

  it('(f) a move of more than 150 m during backoff fetches once right away and keeps the backoff step', async () => {
    const { calls, onError } = await failedWindowRefetch();

    await emit(position(walk(1)));
    await advance(500);
    await emit(position(FAR));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(3);
    expect(nearbyCalls(calls)[2]!.url).toContain(`lng=${FAR.lng}`);
    // The immediate fetch failed too: the backoff continues with the next step, not 2 s.
    expectLastError(onError, 'retrying in 5000 ms');

    // Near the far attempt, or back near the last successful fetch: no further immediate fetch.
    await emit(position({ lng: FAR.lng + 0.0001, lat: FAR.lat }));
    await emit(position({ lng: FAR.lng + 0.0002, lat: FAR.lat + 0.0001 }));
    await emit(position(walk(2)));
    await emit(position({ lng: FAR.lng + 0.0003, lat: FAR.lat }));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(3);

    await advance(4999); // the cancelled 2 s retry does not fire either
    expect(nearbyCalls(calls)).toHaveLength(3);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(4);
    expect(nearbyCalls(calls)[3]!.url).toContain(`lng=${FAR.lng + 0.0003}`);
    expectLastError(onError, 'retrying in 15000 ms');
    await advance(14_999);
    expect(nearbyCalls(calls)).toHaveLength(4);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(5);
  });

  it('(g) a successful fetch after retries resets the backoff to 2 s', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const replies: (() => Reply)[] = [unavailable, unavailable, () => nearbyReply(SERVICE_DROPS, Date.now() + 10_000)];
    const calls = mockFetch(() => (replies.shift() ?? unavailable)());
    const onError = jest.fn();
    await renderLayer({}, { onError });
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);
    expectLastError(onError, 'retrying in 2000 ms');
    await advance(2000);
    expect(nearbyCalls(calls)).toHaveLength(2);
    expectLastError(onError, 'retrying in 5000 ms');
    await advance(5000);
    expect(nearbyCalls(calls)).toHaveLength(3);
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
    expect(onError).toHaveBeenCalledTimes(2);

    // The window refetch fails: the schedule starts again at 2 s.
    await advance(10_050);
    expect(nearbyCalls(calls)).toHaveLength(4);
    expect(onError).toHaveBeenCalledTimes(3);
    expectLastError(onError, 'retrying in 2000 ms');
    await advance(1999);
    expect(nearbyCalls(calls)).toHaveLength(4);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(5);
    expectLastError(onError, 'retrying in 5000 ms');
  });

  it('does not retry a permanent fetch error (401 INVALID_KEY) and resumes when the config changes', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const calls = mockFetch(({ init }) =>
      init.headers.Authorization === 'Bearer nope'
        ? { status: 401, body: { error: { code: 'INVALID_KEY', message: 'bad key' } } }
        : nearbyReply(SERVICE_DROPS),
    );
    const onError = jest.fn();
    const { rerender } = await renderLayer({ apiKey: 'nope' }, { onError });
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({
      code: 'drops_fetch_failed',
      message: expect.stringContaining('INVALID_KEY'),
      fatal: true,
    });
    expectLastError(onError, 'not retrying');

    // Neither time, small moves nor a move of more than 150 m fetch again.
    await emit(position(walk(3)));
    await advance(60_000);
    await emit(position(FAR));
    await advance(60_000);
    expect(nearbyCalls(calls)).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // A new key restarts fetching at the latest position.
    await rerender(layerTree({ apiKey: 'client-key' }, { onError }));
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(2);
    expect(nearbyCalls(calls)[1]!.url).toContain(`lng=${FAR.lng}`);
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP 400 without a code', { status: 400, body: null }],
    ['HTTP 403 FORBIDDEN_ROLE', { status: 403, body: { error: { code: 'FORBIDDEN_ROLE', message: 'no' } } }],
    ['HTTP 404 without a code', { status: 404, body: null }],
    ['HTTP 422 INVALID_RADIUS', { status: 422, body: { error: { code: 'INVALID_RADIUS', message: 'no' } } }],
  ])('does not retry %s', async (_name, reply) => {
    jest.useFakeTimers({ now: 1_000_000 });
    const calls = mockFetch(() => reply);
    const onError = jest.fn();
    await renderLayer({}, { onError });
    await readyWithPosition();
    await advance(120_000);
    expect(nearbyCalls(calls)).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'drops_fetch_failed', fatal: true }));
  });

  it('honours Retry-After on 429 with a 2 s minimum, then falls back to the schedule', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const tooMany = (headers?: Record<string, string>): Reply => ({
      status: 429,
      body: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
      ...(headers ? { headers } : {}),
    });
    const replies: Reply[] = [tooMany({ 'Retry-After': '30' }), tooMany({ 'retry-after': '1' }), tooMany(), nearbyReply(SERVICE_DROPS)];
    const calls = mockFetch(() => replies.shift() ?? unavailable());
    const onError = jest.fn();
    await renderLayer({}, { onError });
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ fatal: false }));
    expectLastError(onError, 'retrying in 30000 ms');

    await emit(position(walk(1)));
    await advance(29_999);
    expect(nearbyCalls(calls)).toHaveLength(1);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(2);
    // Retry-After: 1 is raised to the 2 s minimum.
    expectLastError(onError, 'retrying in 2000 ms');
    await advance(1999);
    expect(nearbyCalls(calls)).toHaveLength(2);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(3);
    // Without Retry-After, the schedule continues at its third step.
    expectLastError(onError, 'retrying in 15000 ms');
    await advance(14_999);
    expect(nearbyCalls(calls)).toHaveLength(3);
    await advance(1);
    expect(nearbyCalls(calls)).toHaveLength(4);
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('clears drops hidden on collect when the service config changes', async () => {
    const gems = deferred<Reply>();
    const calls = mockFetch(({ url }) => {
      if (url.includes('/v1/drops/collect')) return { status: 422, body: { error: { code: 'ALREADY_COLLECTED', message: 'taken' } } };
      return url.includes('channel=gems') ? gems.promise : nearbyReply(SERVICE_DROPS);
    });
    const { rerender } = await renderLayer();
    await readyWithPosition();
    await nextFrame();
    await emit({ type: 'drop:collect', layerId: 'coins', dropId: SERVICE_DROPS[0]!.id, characterId: 'me', coordinate: HOME, collectId: 'collect-0001' });
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual([SERVICE_DROPS[1]]);

    // Same drops under another channel: the old hidden id does not carry over,
    // and the old channel's drops are not shown while the new fetch is pending.
    clearPosted();
    await rerender(layerTree({ channel: 'gems' }));
    await flushPromises();
    await nextFrame();
    expect(nearbyCalls(calls).at(-1)!.url).toContain('channel=gems');
    expect(lastLayerDrops()).toEqual([]);
    await act(async () => {
      gems.resolve(nearbyReply(SERVICE_DROPS));
    });
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);
  });

  it('keeps the drops hidden on collect when the config does not change', async () => {
    mockFetch(({ url }) =>
      url.includes('/v1/drops/collect') ? { status: 422, body: { error: { code: 'ALREADY_COLLECTED', message: 'taken' } } } : nearbyReply(SERVICE_DROPS),
    );
    const onCollect = jest.fn();
    const { rerender } = await renderLayer();
    await readyWithPosition();
    await nextFrame();
    await emit({ type: 'drop:collect', layerId: 'coins', dropId: SERVICE_DROPS[0]!.id, characterId: 'me', coordinate: HOME, collectId: 'collect-0001' });
    await flushPromises();
    // A re-render with a new callback but the same service config.
    await rerender(layerTree({ onCollect }));
    await flushPromises();
    await nextFrame();
    expect(lastLayerDrops()).toEqual([SERVICE_DROPS[1]]);
  });

  it('stops fetching and retrying after unmount', async () => {
    jest.useFakeTimers();
    const calls = mockFetch(() => ({ status: 500, body: null }));
    const { unmount } = await renderLayer();
    await readyWithPosition();
    expect(nearbyCalls(calls)).toHaveLength(1);
    await unmount();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await flushPromises();
    expect(nearbyCalls(calls)).toHaveLength(1);
  });

  it('shows a rejected drop again for retryable codes and keeps it hidden for final ones', async () => {
    mockFetch(({ url, init }) => {
      if (url.includes('/v1/drops/nearby')) return nearbyReply(SERVICE_DROPS);
      const { dropId } = JSON.parse(init.body!) as { dropId: string };
      const code = dropId === SERVICE_DROPS[0]!.id ? 'ALREADY_COLLECTED' : 'TOO_FAR';
      return { status: 422, body: { error: { code, message: code } } };
    });
    const onCollectRejected = jest.fn();
    await renderLayer({ onCollectRejected });
    await readyWithPosition();
    await nextFrame();
    expect(lastLayerDrops()).toEqual(SERVICE_DROPS);

    // Final code: hidden immediately on collect, and stays hidden.
    await emit({ type: 'drop:collect', layerId: 'coins', dropId: SERVICE_DROPS[0]!.id, characterId: 'me', coordinate: HOME, collectId: 'collect-0001' });
    expect(lastLayerDrops()).toEqual([SERVICE_DROPS[1]]);
    await flushPromises();
    await nextFrame();
    expect(onCollectRejected).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'ALREADY_COLLECTED' }));
    expect(lastLayerDrops()).toEqual([SERVICE_DROPS[1]]);

    // Retryable code: hidden on collect, shown again after the rejection.
    await emit({ type: 'drop:collect', layerId: 'coins', dropId: SERVICE_DROPS[1]!.id, characterId: 'me', coordinate: HOME, collectId: 'collect-0002' });
    expect(lastLayerDrops()).toEqual([]);
    await flushPromises();
    await nextFrame();
    expect(onCollectRejected).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'TOO_FAR' }));
    expect(lastLayerDrops()).toEqual([SERVICE_DROPS[1]]);
  });

});

describe('NearbyDropsTracker timing safeguards', () => {
  const NOW = 1_700_000_000_000;

  function tracker(fetchImpl: () => Promise<{ drops: DropSpec[]; generatedAt: number; expiresAt: number | null }>) {
    const fetches: LngLat[] = [];
    const errors: (number | null)[] = [];
    const t = new NearbyDropsTracker({
      fetch: (center) => {
        fetches.push(center);
        return fetchImpl();
      },
      onDrops: () => {},
      onError: (_e, retryInMs) => errors.push(retryInMs),
    });
    return { t, fetches, errors };
  }

  it('schedules the next window no sooner than MIN_RETRY_AFTER_MS when expiresAt is already past', async () => {
    jest.useFakeTimers({ now: NOW });
    // server clock behind the device: the window "expired" a minute ago
    const { t, fetches } = tracker(async () => ({ drops: [], generatedAt: Date.now(), expiresAt: Date.now() - 60_000 }));
    t.start();
    t.updatePosition(HOME, 150);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);
    // no tight refetch loop and no early refetch from position updates
    await jest.advanceTimersByTimeAsync(MIN_RETRY_AFTER_MS - 1);
    t.updatePosition(SMALL_MOVES[0]!, 150);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);
    // the window timer fires shortly after the 2 s floor (+50 ms slack)
    await jest.advanceTimersByTimeAsync(100);
    expect(fetches).toHaveLength(2);
    t.stop();
  });

  it('caps a server Retry-After at MAX_RETRY_AFTER_MS', async () => {
    jest.useFakeTimers({ now: NOW });
    let fail = true;
    const { t, fetches, errors } = tracker(async () => {
      if (fail) throw new DropsServiceError('RATE_LIMITED', 'slow down', 429, 60 * 60 * 1000);
      return { drops: [], generatedAt: Date.now(), expiresAt: null };
    });
    t.start();
    t.updatePosition(HOME, 150);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetches).toHaveLength(1);
    expect(errors).toEqual([MAX_RETRY_AFTER_MS]);
    fail = false;
    await jest.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS - 1);
    expect(fetches).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetches).toHaveLength(2);
    t.stop();
  });
});

describe('shouldRestoreRejectedDrop', () => {
  it.each([
    ['TOO_FAR', 422],
    ['TELEPORT', 422],
    ['STALE_FIX', 422],
    ['QUOTA_EXCEEDED', 429],
    ['NETWORK_ERROR', 0],
    ['INVALID_RESPONSE', 200],
    ['HTTP_500', 500],
    ['HTTP_503', 503],
  ])('restores after %s', (code, status) => {
    expect(shouldRestoreRejectedDrop(code, status)).toBe(true);
  });

  it.each([
    ['ALREADY_COLLECTED', 422],
    ['DROP_EXPIRED', 422],
    ['DROP_NOT_FOUND', 404],
    ['COLLECT_ID_CONFLICT', 409],
  ])('keeps hidden after %s', (code, status) => {
    expect(shouldRestoreRejectedDrop(code, status)).toBe(false);
  });
});

describe('isRetryableFetchError', () => {
  it.each([
    ['NETWORK_ERROR', 0],
    ['INVALID_RESPONSE', 200],
    ['HTTP_408', 408],
    ['RATE_LIMITED', 429],
    ['HTTP_500', 500],
    ['UNAVAILABLE', 503],
  ])('retries %s (%d)', (code, status) => {
    expect(isRetryableFetchError(new DropsServiceError(code, code, status))).toBe(true);
  });

  it('retries unexpected non-service errors', () => {
    expect(isRetryableFetchError(new TypeError('boom'))).toBe(true);
  });

  it.each([
    ['HTTP_400', 400],
    ['BAD_REQUEST', 400],
    ['INVALID_KEY', 401],
    ['MISSING_KEY', 401],
    ['MALFORMED_AUTHORIZATION', 401],
    ['FORBIDDEN_ROLE', 403],
    ['QUERY_KEY_NOT_ALLOWED', 403],
    ['HTTP_404', 404],
    ['INVALID_RADIUS', 422],
    ['INVALID_CHANNEL', 400],
    ['HTTP_410', 410],
    ['INVALID_KEY', 500],
  ])('does not retry %s (%d)', (code, status) => {
    expect(isRetryableFetchError(new DropsServiceError(code, code, status))).toBe(false);
  });
});

describe('drops service client', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-15T00:00:00Z');
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
    expect(parseRetryAfterMs('Tue, 15 Sep 2026 00:00:45 GMT', now)).toBe(45_000);
    expect(parseRetryAfterMs('Mon, 14 Sep 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs('', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('exposes Retry-After on HTTP errors', async () => {
    const cfg = { baseUrl: 'https://api.example', apiKey: 'k' };
    mockFetch(() => ({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow' } }, headers: { 'Retry-After': '7' } }));
    await expect(fetchNearbyDrops(cfg, { lng: 1, lat: 2, channel: 'c' })).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterMs: 7000 });
    mockFetch(() => ({ status: 503, body: null }));
    await expect(fetchNearbyDrops(cfg, { lng: 1, lat: 2, channel: 'c' })).rejects.toMatchObject({ code: 'HTTP_503', retryAfterMs: undefined });
  });

  const config = { baseUrl: 'https://api.example', apiKey: 'k' };

  it('accepts a bare array and rejects invalid drops', async () => {
    mockFetch(() => ({ status: 200, body: [{ id: 'a', type: 'coin', coordinate: HOME }] }));
    await expect(fetchNearbyDrops(config, { lng: 1, lat: 2, channel: 'c' })).resolves.toEqual({
      drops: [{ id: 'a', type: 'coin', coordinate: HOME }],
      generatedAt: null,
      expiresAt: null,
    });
    mockFetch(() => ({ status: 200, body: { drops: [{ id: 'a', type: 'banana', coordinate: HOME }] } }));
    await expect(fetchNearbyDrops(config, { lng: 1, lat: 2, channel: 'c' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('maps HTTP and network errors to DropsServiceError', async () => {
    const request = { dropId: 'd', collectId: 'collect-1', userId: 'u', fix: { lng: 1, lat: 2, accuracyMeters: 5, timestamp: 1 } };
    mockFetch(() => ({ status: 422, body: { code: 'ALREADY_COLLECTED' } }));
    await expect(verifyDropCollect(config, request)).rejects.toMatchObject({ code: 'ALREADY_COLLECTED', status: 422 });
    mockFetch(() => ({ status: 500, body: null }));
    await expect(verifyDropCollect(config, request)).rejects.toMatchObject({ code: 'HTTP_500', status: 500 });
    const failing = async () => {
      throw new Error('offline');
    };
    const error = await verifyDropCollect({ ...config, fetch: failing }, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DropsServiceError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});
