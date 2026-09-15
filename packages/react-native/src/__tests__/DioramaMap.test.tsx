import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRef, useCallback, useEffect, type Ref } from 'react';
import { Image, Linking, StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { encodeEvent, type EngineEvent, type LabelInfo, type WorldSource } from '@diorama/protocol';
import {
  Character,
  CharacterLayer,
  DioramaMap,
  Geofence,
  MapOverlay,
  createMessageChannelHost,
  registerEngineHost,
  type DioramaMapProps,
  type DioramaMapRef,
  type EngineHostComponentProps,
} from '../index';
import { ENGINE_HTML } from '@diorama/engine-web/engine-html';
import {
  READY,
  clearPosted,
  commandTypes,
  commands,
  commandsOf,
  emit,
  emitRaw,
  flushPromises,
  latestWebView,
  nextFrame,
  pendingFrames,
  webViewInstances,
} from './helpers';

const WORLD: WorldSource = { kind: 'procedural', layout: 'town' };
const PLAZA = { lng: 127.056, lat: 37.544 };

function Map(props: Partial<DioramaMapProps> & { ref?: Ref<DioramaMapRef> }) {
  return <DioramaMap world={WORLD} {...props} />;
}

beforeEach(() => {
  webViewInstances.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('engine host', () => {
  it('renders the web engine in a transparent, non-scrolling WebView', async () => {
    await render(<Map />);
    const { props } = latestWebView();
    expect(props.source).toEqual({ html: ENGINE_HTML });
    expect(props.javaScriptEnabled).toBe(true);
    expect(props.allowsInlineMediaPlayback).toBe(true);
    expect(props.bounces).toBe(false);
    expect(props.scrollEnabled).toBe(false);
    expect(StyleSheet.flatten(props.style as never)).toMatchObject({ backgroundColor: 'transparent' });
  });

  it('keeps the WebView on the inline engine document and opens external links outside', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockImplementation(async () => {});
    await render(<Map />);
    const { props } = latestWebView();
    expect(props.originWhitelist).toEqual(['about:blank', 'about:srcdoc', 'data:*']);
    expect(props.allowFileAccess).toBe(false);
    expect(props.mixedContentMode).toBe('never');

    const guard = props.onShouldStartLoadWithRequest as (request: { url: string }) => boolean;
    expect(guard({ url: 'about:blank' })).toBe(true);
    expect(guard({ url: 'data:text/html;charset=utf-8,<html></html>' })).toBe(true);
    await act(async () => {
      (props.onLoadEnd as () => void)();
    });
    // After the engine document loaded, nothing may replace it.
    expect(guard({ url: 'about:blank' })).toBe(true);
    expect(guard({ url: 'data:text/html;charset=utf-8,<script>forge()</script>' })).toBe(false);
    expect(guard({ url: 'file:///data/local/tmp/evil.html' })).toBe(false);
    expect(guard({ url: 'javascript:alert(1)' })).toBe(false);
    expect(guard({ url: 'myapp://callback' })).toBe(false);
    expect(guard({ url: 'https://evil.example/fake-engine.html' })).toBe(false);
    expect(guard({ url: 'http://example.com/docs' })).toBe(false);
    await flushPromises();
    expect(openURL.mock.calls).toEqual([['https://evil.example/fake-engine.html'], ['http://example.com/docs']]);
  });

  it('queues commands until ready, then sends init followed by the queue in order', async () => {
    const ref = createRef<DioramaMapRef>();
    await render(
      <Map ref={ref} theme={{ base: 'urban', timeOfDay: 'golden' }} camera={{ pitch: 45, distance: 60, follow: 'me' }}>
        <Character id="me" isPlayer follow="location" />
      </Map>,
    );
    await nextFrame();
    ref.current!.setCamera({ distance: 40, animate: true });
    ref.current!.setBuildingStyle('b1', { roof: 'gable', state: 'captured' });
    expect(latestWebView().posted).toHaveLength(0);
    expect(ref.current!.isReady()).toBe(false);

    await emit(READY);

    expect(commandTypes()).toEqual(['init', 'upsertCharacters', 'setCamera', 'setBuildingStyle']);
    const [init] = commands();
    expect(init).toEqual({
      type: 'init',
      world: WORLD,
      theme: { base: 'urban', timeOfDay: 'golden' },
      labels: {},
      ui: {},
      camera: { pitch: 45, distance: 60, follow: 'me' },
      locationSource: 'external',
    });
    expect(ref.current!.isReady()).toBe(true);
    expect(ref.current!.getEngineInfo()).toEqual(READY.type === 'ready' ? READY.engine : null);
  });

  it('calls onReady after init', async () => {
    const onReady = jest.fn();
    await render(<Map onReady={onReady} />);
    await emit(READY);
    expect(onReady).toHaveBeenCalledWith({ engine: { name: 'diorama-web', version: '0.0.0-test', kind: 'web' } });
  });

  it('folds prop changes made before ready into init', async () => {
    const { rerender } = await render(<Map theme={{ base: 'toy' }} />);
    await rerender(<Map theme={{ base: 'soft' }} />);
    await emit(READY);
    expect(commandTypes()).toEqual(['init']);
    expect(commandsOf('init')[0]!.theme).toEqual({ base: 'soft' });
  });

  it('re-initialises and re-sends declarative state after an engine reload', async () => {
    await render(
      <Map>
        <Character id="me" isPlayer />
        <Geofence id="plaza" center={PLAZA} radiusMeters={60} />
      </Map>,
    );
    await emit(READY);
    await nextFrame();
    clearPosted();
    await emit(READY);
    expect(commandTypes()).toEqual(['init', 'upsertCharacters', 'setGeofences']);
  });

  it('supports a custom engine host from the registry', async () => {
    const posted: string[] = [];
    let feed: ((raw: unknown) => string | null) | null = null;
    function FakeNativeHost({ onHost }: EngineHostComponentProps) {
      useEffect(() => {
        const channel = createMessageChannelHost('native', (data) => posted.push(data));
        feed = channel.receive;
        onHost(channel.host);
        return () => channel.host.destroy();
      }, [onHost]);
      return null;
    }
    const restore = registerEngineHost('fake-native', FakeNativeHost);
    try {
      await render(<Map engine="fake-native" />);
      expect(webViewInstances).toHaveLength(0);
      feed!(encodeEvent({ type: 'ready', engine: { name: 'native', version: '1', kind: 'native' } }, 0));
      expect(posted.map((p) => JSON.parse(p).msg.type)).toEqual(['init']);
    } finally {
      restore();
    }
  });

  it('reports a missing engine host through onError', async () => {
    const onError = jest.fn();
    await render(<Map engine="does-not-exist" onError={onError} />);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unsupported', fatal: true }));
  });
});

describe('prop diffs', () => {
  async function readyMap(initial: Partial<DioramaMapProps>) {
    const utils = await render(<Map {...initial} />);
    await emit(READY);
    await nextFrame();
    clearPosted();
    return utils;
  }

  it('sends only the commands for props that changed', async () => {
    const initial: Partial<DioramaMapProps> = {
      theme: { base: 'urban' },
      labels: { enabled: true, style: 'holo' },
      ui: { scaleBar: true },
      camera: { pitch: 45, distance: 60, follow: 'me' },
    };
    const { rerender } = await readyMap(initial);

    await rerender(<Map {...initial} theme={{ base: 'urban' }} labels={{ enabled: true, style: 'holo' }} />);
    expect(commandTypes()).toEqual([]);

    await rerender(<Map {...initial} theme={{ base: 'urban', timeOfDay: 'night' }} />);
    expect(commands()).toEqual([{ type: 'setTheme', theme: { base: 'urban', timeOfDay: 'night' } }]);
    clearPosted();

    await rerender(<Map {...initial} theme={{ base: 'urban', timeOfDay: 'night' }} camera={{ pitch: 30, distance: 60, follow: 'me', animate: true }} />);
    expect(commands()).toEqual([{ type: 'setCamera', camera: { pitch: 30, animate: true } }]);
    clearPosted();

    await rerender(<Map {...initial} theme={{ base: 'urban', timeOfDay: 'night' }} camera={{ pitch: 30, distance: 60 }} />);
    expect(commands()).toEqual([{ type: 'setCamera', camera: { follow: null } }]);
    clearPosted();

    await rerender(
      <Map {...initial} theme={{ base: 'urban', timeOfDay: 'night' }} camera={{ pitch: 30, distance: 60 }} labels={{ enabled: false, style: 'holo' }} ui={{ scaleBar: false }} />,
    );
    expect(commands()).toEqual([
      { type: 'setLabels', labels: { enabled: false, style: 'holo' } },
      { type: 'setUi', ui: { scaleBar: false } },
    ]);
  });

  it('switches the location source', async () => {
    const { rerender } = await readyMap({ location: { source: 'external' } });
    await rerender(<Map location={{ source: 'simulated' }} />);
    expect(commands()).toEqual([{ type: 'setLocationSource', source: 'simulated' }]);
  });
});

describe('children', () => {
  it('batches registrations into one command per kind per frame', async () => {
    const { rerender } = await render(<Map />);
    await emit(READY);
    clearPosted();

    await rerender(
      <Map>
        <Character id="me" isPlayer follow="location" animations={{ walk: 'Walking_Loop' }} />
        <Character id="npc" position={PLAZA} name="Guide" />
        <Geofence id="plaza" center={PLAZA} radiusMeters={60} />
        <Geofence id="shop" center={{ lng: 127.05, lat: 37.54 }} radiusMeters={20} />
      </Map>,
    );
    // Registrations wait for the frame (frames only run through nextFrame in tests).
    expect(commandTypes()).toEqual([]);
    expect(pendingFrames()).toBe(1);
    await nextFrame();
    expect(commands()).toEqual([
      {
        type: 'upsertCharacters',
        characters: [
          { id: 'me', follow: 'location', isPlayer: true, animations: { walk: 'Walking_Loop' } },
          { id: 'npc', name: 'Guide', position: PLAZA },
        ],
      },
      {
        type: 'setGeofences',
        geofences: [
          { id: 'plaza', center: PLAZA, radiusMeters: 60 },
          { id: 'shop', center: { lng: 127.05, lat: 37.54 }, radiusMeters: 20 },
        ],
      },
    ]);
    clearPosted();

    // Re-render with identical children: no traffic.
    await rerender(
      <Map>
        <Character id="me" isPlayer follow="location" animations={{ walk: 'Walking_Loop' }} />
        <Character id="npc" position={PLAZA} name="Guide" />
        <Geofence id="plaza" center={PLAZA} radiusMeters={60} />
        <Geofence id="shop" center={{ lng: 127.05, lat: 37.54 }} radiusMeters={20} />
      </Map>,
    );
    await nextFrame();
    expect(commandTypes()).toEqual([]);

    await rerender(
      <Map>
        <Character id="me" isPlayer follow="location" animations={{ walk: 'Walking_Loop' }} />
        <Geofence id="plaza" center={PLAZA} radiusMeters={60} />
      </Map>,
    );
    await nextFrame();
    expect(commands()).toEqual([
      { type: 'removeCharacters', ids: ['npc'] },
      { type: 'setGeofences', geofences: [{ id: 'plaza', center: PLAZA, radiusMeters: 60 }] },
    ]);
  });

  it('diffs CharacterLayer items and resolves models', async () => {
    jest.spyOn(Image, 'resolveAssetSource').mockImplementation((n: unknown) => ({ uri: `asset:/${String(n)}.glb`, width: 0, height: 0, scale: 1 }) as never);
    type Player = { id: string; coord: { lng: number; lat: number }; avatar: string | number };
    const layer = (players: Player[]) => (
      <Map>
        <CharacterLayer data={players} getId={(p) => p.id} getPosition={(p) => p.coord} getModel={(p) => p.avatar} />
      </Map>
    );
    const a: Player = { id: 'a', coord: PLAZA, avatar: 'https://cdn.example/a.glb' };
    const b: Player = { id: 'b', coord: { lng: 127.05, lat: 37.54 }, avatar: 42 };
    const { rerender } = await render(layer([a, b]));
    await emit(READY);
    await nextFrame();
    expect(commandsOf('upsertCharacters')[0]!.characters).toEqual([
      { id: 'a', position: PLAZA, follow: 'none', model: { uri: 'https://cdn.example/a.glb' } },
      { id: 'b', position: { lng: 127.05, lat: 37.54 }, follow: 'none', model: { uri: 'asset:/42.glb' } },
    ]);
    clearPosted();

    await rerender(layer([a, { ...b, coord: { lng: 127.051, lat: 37.541 } }]));
    await nextFrame();
    expect(commands()).toEqual([
      { type: 'upsertCharacters', characters: [{ id: 'b', position: { lng: 127.051, lat: 37.541 }, follow: 'none', model: { uri: 'asset:/42.glb' } }] },
    ]);
    clearPosted();

    await rerender(layer([]));
    await nextFrame();
    expect(commands()).toEqual([{ type: 'removeCharacters', ids: ['a', 'b'] }]);
  });

  it('clears a removed model so the engine shows its default avatar again', async () => {
    const hero = 'https://cdn.example/hero.glb';
    const { rerender } = await render(
      <Map>
        <Character id="me" isPlayer model={hero} />
      </Map>,
    );
    await emit(READY);
    await nextFrame();
    expect(commandsOf('upsertCharacters')[0]!.characters).toEqual([{ id: 'me', isPlayer: true, model: { uri: hero } }]);
    clearPosted();

    await rerender(
      <Map>
        <Character id="me" isPlayer />
      </Map>,
    );
    await nextFrame();
    expect(commands()).toEqual([{ type: 'upsertCharacters', characters: [{ id: 'me', isPlayer: true, model: null }] }]);
    clearPosted();

    // Still no model: nothing more to send.
    await rerender(
      <Map>
        <Character id="me" isPlayer name="Me" />
      </Map>,
    );
    await nextFrame();
    expect(commands()).toEqual([{ type: 'upsertCharacters', characters: [{ id: 'me', isPlayer: true, name: 'Me' }] }]);
  });

  it('removes everything a child registered when it unmounts', async () => {
    const { rerender } = await render(
      <Map>
        <Character id="me" isPlayer />
        <MapOverlay coordinate={PLAZA} id="card" />
      </Map>,
    );
    await emit(READY);
    await nextFrame();
    clearPosted();
    await rerender(<Map />);
    await nextFrame();
    expect(commands()).toEqual([
      { type: 'removeCharacters', ids: ['me'] },
      { type: 'setOverlayAnchors', anchors: [] },
    ]);
  });

  it('routes geofence events to the matching Geofence', async () => {
    const onEnter = jest.fn();
    const onExit = jest.fn();
    const other = jest.fn();
    await render(
      <Map>
        <Geofence id="plaza" center={PLAZA} radiusMeters={60} onEnter={onEnter} onExit={onExit} />
        <Geofence id="shop" center={PLAZA} radiusMeters={10} onEnter={other} />
      </Map>,
    );
    await emit(READY);
    await emit({ type: 'geofence:enter', geofenceId: 'plaza', characterId: 'me' });
    await emit({ type: 'geofence:exit', geofenceId: 'plaza', characterId: 'me' });
    expect(onEnter).toHaveBeenCalledWith({ geofenceId: 'plaza', characterId: 'me' });
    expect(onExit).toHaveBeenCalledWith({ geofenceId: 'plaza', characterId: 'me' });
    expect(other).not.toHaveBeenCalled();
  });

  it('applies overlay positions to the overlay view', async () => {
    const { getByTestId } = await render(
      <Map>
        <MapOverlay id="shop" coordinate={PLAZA} anchor="bottom" testID="overlay" />
      </Map>,
    );
    await emit(READY);
    await nextFrame();
    expect(commandsOf('setOverlayAnchors')).toEqual([{ type: 'setOverlayAnchors', anchors: [{ id: 'shop', coordinate: PLAZA }] }]);

    const overlay = getByTestId('overlay');
    await fireEvent(overlay, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 40 } } });
    await emit({ type: 'overlay:positions', positions: [{ id: 'shop', x: 200, y: 300, visible: true }] });

    const style = StyleSheet.flatten(getByTestId('overlay').props.style as never) as {
      opacity: number;
      transform: { translateX?: number; translateY?: number }[];
    };
    expect(style.opacity).toBe(1);
    expect(style.transform).toEqual([{ translateX: 150 }, { translateY: 260 }]);

    await emit({ type: 'overlay:positions', positions: [{ id: 'shop', x: -50, y: 300, visible: false }] });
    const hidden = StyleSheet.flatten(getByTestId('overlay').props.style as never) as { opacity: number };
    expect(hidden.opacity).toBe(0);
  });
});

describe('labels', () => {
  const INDEX: LabelInfo[] = [
    { id: 'poi-1', kind: 'poi', name: 'Vinyl Shop', category: 'music', lngLat: PLAZA },
    { id: 'road-1', kind: 'road', name: 'Seongsu-ro', lngLat: PLAZA },
  ];

  it('evaluates a content function once per labelsIndex and sends setLabelContent', async () => {
    const content = jest.fn((label: LabelInfo) =>
      label.category === 'music' ? { title: label.name, subtitle: '오늘의 드롭 3곡', icon: 'music' as const } : { title: label.name },
    );
    function App({ tick }: { tick: number }) {
      const fn = useCallback(content, []);
      return <Map labels={{ enabled: true, style: 'holo', icons: 'auto', content: fn }} ui={{ scaleBar: tick > 1 }} />;
    }
    const { rerender } = await render(<App tick={0} />);
    await emit(READY);
    expect(commandsOf('init')[0]!.labels).toEqual({ enabled: true, style: 'holo', icons: 'auto', content: 'custom' });
    clearPosted();

    await emit({ type: 'labelsIndex', labels: INDEX });
    expect(content).toHaveBeenCalledTimes(2);
    await nextFrame();
    expect(commands()).toEqual([
      {
        type: 'setLabelContent',
        entries: {
          'poi-1': { title: 'Vinyl Shop', subtitle: '오늘의 드롭 3곡', icon: 'music' },
          'road-1': { title: 'Seongsu-ro' },
        },
      },
    ]);
    clearPosted();

    // Re-renders with the same function do not re-evaluate or re-send.
    await rerender(<App tick={1} />);
    await nextFrame();
    expect(content).toHaveBeenCalledTimes(2);
    expect(commandTypes()).toEqual([]);

    // A new index re-evaluates.
    await emit({ type: 'labelsIndex', labels: INDEX.slice(0, 1) });
    expect(content).toHaveBeenCalledTimes(3);
  });

  it('does not re-evaluate an inline content function on re-renders; label field changes and refreshLabelContent do', async () => {
    const evaluated: string[] = [];
    let suffix = 'a';
    const ref = createRef<DioramaMapRef>();
    function App({ tick, enabled = true }: { tick: number; enabled?: boolean }) {
      return (
        <Map
          ref={ref}
          labels={{
            enabled,
            content: (label) => {
              evaluated.push(label.id);
              return { title: `${label.name} ${suffix}` };
            },
          }}
          ui={{ scaleBar: tick % 2 === 0 }}
        />
      );
    }
    const { rerender } = await render(<App tick={0} />);
    await emit(READY);
    await emit({ type: 'labelsIndex', labels: INDEX });
    await nextFrame();
    expect(evaluated).toHaveLength(2);
    expect(commandsOf('setLabelContent')).toHaveLength(1);
    clearPosted();

    // Every render creates a new function identity: no evaluation, no label traffic.
    for (const tick of [1, 2, 3]) await rerender(<App tick={tick} />);
    await nextFrame();
    expect(evaluated).toHaveLength(2);
    expect(commandTypes()).toEqual(['setUi', 'setUi', 'setUi']);
    clearPosted();

    // A non-function field changed: evaluated once (entries are unchanged, so nothing is re-sent).
    await rerender(<App tick={3} enabled={false} />);
    await nextFrame();
    expect(evaluated).toHaveLength(4);
    expect(commandTypes()).toEqual(['setLabels']);
    clearPosted();

    // Explicit refresh with changed data read by the latest function.
    suffix = 'b';
    await act(async () => {
      ref.current!.refreshLabelContent();
    });
    expect(evaluated).toHaveLength(6);
    await nextFrame();
    expect(commands()).toEqual([
      { type: 'setLabelContent', entries: { 'poi-1': { title: 'Vinyl Shop b' }, 'road-1': { title: 'Seongsu-ro b' } } },
    ]);
  });
});

describe('events and errors', () => {
  it('routes presses', async () => {
    const onPress = jest.fn();
    const onBuildingPress = jest.fn();
    await render(<Map onPress={onPress} onBuildingPress={onBuildingPress} />);
    await emit(READY);
    await emit({ type: 'map:press', coordinate: PLAZA });
    await emit({ type: 'building:press', buildingId: 'b-7', coordinate: PLAZA });
    expect(onPress).toHaveBeenCalledWith({ coordinate: PLAZA });
    expect(onBuildingPress).toHaveBeenCalledWith({ buildingId: 'b-7', coordinate: PLAZA });
  });

  it('reports malformed engine messages through onError without crashing', async () => {
    const onError = jest.fn();
    const onPress = jest.fn();
    await render(<Map onError={onError} onPress={onPress} />);
    await emitRaw('not json');
    await emitRaw(JSON.stringify({ v: 1, seq: 0, kind: 'evt', msg: { type: 'map:press', coordinate: { lng: 999, lat: 0 } } }));
    await emitRaw(JSON.stringify({ v: 99, seq: 0, kind: 'evt', msg: READY }));
    await emitRaw(42);
    expect(onError).toHaveBeenCalledTimes(4);
    for (const [arg] of onError.mock.calls) expect(arg).toEqual(expect.objectContaining({ code: 'invalid_message', fatal: false }));
    expect(onPress).not.toHaveBeenCalled();

    // Still works afterwards.
    await emit(READY);
    expect(commandTypes()).toEqual(['init']);
  });

  it('normalises engine error codes', async () => {
    const onError = jest.fn();
    await render(<Map onError={onError} />);
    const events: EngineEvent[] = [
      { type: 'error', code: 'NOT_IMPLEMENTED', message: 'command "travel" is not implemented', fatal: false },
      { type: 'error', code: 'world_load_failed', message: '404', fatal: true },
    ];
    for (const e of events) await emit(e);
    expect(onError.mock.calls.map(([e]) => e)).toEqual([
      { code: 'unsupported', message: 'command "travel" is not implemented', fatal: false },
      { code: 'world_load_failed', message: '404', fatal: true },
    ]);
  });

  it('reports a crashing app callback as listener_error', async () => {
    const onError = jest.fn();
    await render(
      <Map
        onError={onError}
        onPress={() => {
          throw new Error('boom');
        }}
      />,
    );
    await emit({ type: 'map:press', coordinate: PLAZA });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'listener_error' }));
  });
});
