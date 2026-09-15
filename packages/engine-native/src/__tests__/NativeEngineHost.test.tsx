import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react-native';
import { decodeCommand, encodeEvent, type EngineCommand, type EngineEvent } from '@maprama/protocol';
import { MapramaView, getEngineHost, type EngineHost, type EngineHostError } from '@maprama/react-native';
import { setFrameSchedulerForTesting } from '../../../react-native/src/batching';
import { NATIVE_ENGINE_HOST, NativeEngineHost, setEngineModuleForTesting } from '../NativeEngineHost';
import {
  MAX_BUFFERED_ENGINES,
  MAX_BUFFERED_PER_ENGINE,
  attachEngineReceiver,
  ensureEngineEvents,
  resetEngineEventsForTesting,
} from '../events';
import type { EngineEventMessage, Spec } from '../specs/NativeMapramaEngineModule';
import '../index';

/** Props of every rendered `MapramaNativeView` (the codegen component is replaced by a recording View). */
const mockViewProps: { engineId: string; testID?: string }[] = [];

jest.mock('../specs/MapramaNativeViewNativeComponent', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: { engineId: string; testID?: string }) => {
      mockViewProps.push(props);
      return React.createElement(View, { testID: props.testID });
    },
  };
});
// The real spec calls TurboModuleRegistry.get, which returns null under Jest; tests inject a fake instead.
jest.mock('../specs/NativeMapramaEngineModule', () => ({ __esModule: true, default: null }));

interface FakeModule {
  module: Spec;
  posted: { engineId: string; envelope: string }[];
  postMessage: jest.Mock<(engineId: string, envelope: string) => void>;
  postMessages: jest.Mock<(engineId: string, envelopes: ReadonlyArray<string>) => void>;
  listeners: Set<(message: EngineEventMessage) => void>;
  emit(engineId: string, event: EngineEvent): void;
  emitRaw(engineId: string, envelope: string): void;
}

let eventSeq = 0;

function createFakeModule(): FakeModule {
  const posted: FakeModule['posted'] = [];
  const listeners = new Set<(message: EngineEventMessage) => void>();
  const postMessage = jest.fn((engineId: string, envelope: string) => {
    posted.push({ engineId, envelope });
  });
  const postMessages = jest.fn((engineId: string, envelopes: ReadonlyArray<string>) => {
    for (const envelope of envelopes) posted.push({ engineId, envelope });
  });
  const module = {
    postMessage,
    postMessages,
    onEngineEvent: (listener: (message: EngineEventMessage) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  } as unknown as Spec;
  const emitRaw = (engineId: string, envelope: string) => {
    for (const listener of [...listeners]) listener({ engineId, envelope });
  };
  return {
    module,
    posted,
    postMessage,
    postMessages,
    listeners,
    emitRaw,
    emit: (engineId, event) => emitRaw(engineId, encodeEvent(event, eventSeq++)),
  };
}

const READY: EngineEvent = { type: 'ready', engine: { name: 'maprama-native', version: '0.1.0', kind: 'native' } };

function decodedCommands(fake: FakeModule, engineId?: string): EngineCommand[] {
  return fake.posted
    .filter((p) => engineId === undefined || p.engineId === engineId)
    .map((p) => {
      const decoded = decodeCommand(p.envelope);
      if (!decoded.ok) throw new Error(`invalid command envelope: ${decoded.error}`);
      return decoded.value.msg;
    });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function latestEngineId(): string {
  const props = mockViewProps[mockViewProps.length - 1];
  if (!props) throw new Error('no MapramaNativeView rendered');
  return props.engineId;
}

async function renderHost(fake: FakeModule | null) {
  setEngineModuleForTesting(fake ? fake.module : null);
  const hosts: EngineHost[] = [];
  const errors: EngineHostError[] = [];
  const view = await render(
    <NativeEngineHost onHost={(h) => hosts.push(h)} onHostError={(e) => errors.push(e)} options={{ testID: 'map-engine' }} />,
  );
  return { hosts, errors, view };
}

const frameQueue: (() => void)[] = [];
setFrameSchedulerForTesting((callback) => {
  frameQueue.push(callback);
});

async function runFrames(): Promise<void> {
  await act(async () => {
    for (let guard = 0; frameQueue.length > 0 && guard < 100; guard++) {
      for (const callback of frameQueue.splice(0)) callback();
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  mockViewProps.length = 0;
  frameQueue.length = 0;
  resetEngineEventsForTesting();
});

afterEach(() => {
  setEngineModuleForTesting(undefined);
});

describe('registration', () => {
  it('registers the native host when the package is imported', () => {
    expect(NATIVE_ENGINE_HOST).toBe('native');
    expect(getEngineHost('native')).toBe(NativeEngineHost);
  });
});

describe('NativeEngineHost', () => {
  it('renders the native view with a unique engine id and reports a host of kind native', async () => {
    const fake = createFakeModule();
    const a = await renderHost(fake);
    const firstId = latestEngineId();
    const b = await renderHost(fake);
    const secondId = latestEngineId();
    expect(firstId).toMatch(/^maprama-native-/);
    expect(secondId).not.toBe(firstId);
    expect(mockViewProps[0]!.testID).toBe('map-engine');
    expect(a.hosts).toHaveLength(1);
    expect(a.hosts[0]!.kind).toBe('native');
    expect(b.hosts).toHaveLength(1);
    expect(a.errors).toEqual([]);
    // One module-wide subscription however many hosts are mounted.
    expect(fake.listeners.size).toBe(1);
  });

  it('posts encoded commands in order; one JS task is flushed as a single postMessages', async () => {
    const fake = createFakeModule();
    const { hosts } = await renderHost(fake);
    const engineId = latestEngineId();
    const host = hosts[0]!;
    host.send({ type: 'setUi', ui: { scaleBar: true } });
    host.send({ type: 'setCamera', camera: { pitch: 30 } });
    host.send({ type: 'unsubscribe', topic: 'camera:change' });
    expect(fake.posted).toHaveLength(0);
    await flushMicrotasks();
    expect(fake.postMessages).toHaveBeenCalledTimes(1);
    expect(fake.postMessage).not.toHaveBeenCalled();
    expect(decodedCommands(fake, engineId).map((c) => c.type)).toEqual(['setUi', 'setCamera', 'unsubscribe']);
    expect(fake.posted.map((p) => JSON.parse(p.envelope).seq)).toEqual([0, 1, 2]);

    host.send({ type: 'setCamera', camera: { bearing: 10 } });
    await flushMicrotasks();
    expect(fake.postMessage).toHaveBeenCalledTimes(1);
    expect(fake.postMessage.mock.calls[0]![0]).toBe(engineId);
  });

  it('delivers decoded events of its own engine id and resolves ready', async () => {
    const fake = createFakeModule();
    const { hosts } = await renderHost(fake);
    const engineId = latestEngineId();
    const received: EngineEvent[] = [];
    hosts[0]!.onEvent((e) => received.push(e));
    fake.emit('some-other-engine', { type: 'error', code: 'internal', message: 'not mine', fatal: false });
    fake.emit(engineId, READY);
    fake.emit(engineId, {
      type: 'camera:change',
      camera: { center: { lng: 127.05, lat: 37.54 }, distance: 300, pitch: 45, bearing: 28 },
    });
    await expect(hosts[0]!.ready).resolves.toEqual(READY.type === 'ready' ? READY.engine : undefined);
    expect(received.map((e) => e.type)).toEqual(['ready', 'camera:change']);
  });

  it('reports envelopes that fail protocol validation as invalid_message host errors', async () => {
    const fake = createFakeModule();
    const { errors } = await renderHost(fake);
    fake.emitRaw(latestEngineId(), '{"v":1,"seq":0,"kind":"evt","msg":{"type":"nope"}}');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'invalid_message', fatal: false });
  });

  it('stops sending and delivering after unmount', async () => {
    const fake = createFakeModule();
    const { hosts, view } = await renderHost(fake);
    const engineId = latestEngineId();
    const host = hosts[0]!;
    const received: EngineEvent[] = [];
    host.onEvent((e) => received.push(e));
    host.send({ type: 'setCamera', camera: { pitch: 10 } });
    await flushMicrotasks();
    expect(decodedCommands(fake)).toEqual([{ type: 'setCamera', camera: { pitch: 10 } }]);
    await act(async () => {
      view.unmount();
    });
    host.send({ type: 'setCamera', camera: { pitch: 20 } });
    await flushMicrotasks();
    fake.emit(engineId, READY);
    expect(fake.posted).toHaveLength(1);
    expect(received).toEqual([]);
  });

  it('reports a fatal host error and renders nothing when the TurboModule is not linked', async () => {
    const { hosts, errors } = await renderHost(null);
    expect(hosts).toEqual([]);
    expect(mockViewProps).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: 'host_load_failed', fatal: true })]);
  });
});

describe('engine event routing', () => {
  it('buffers events for engines whose host has not attached yet and replays them in order', () => {
    const fake = createFakeModule();
    ensureEngineEvents(fake.module);
    ensureEngineEvents(fake.module);
    expect(fake.listeners.size).toBe(1);
    fake.emitRaw('e1', 'a');
    fake.emitRaw('e1', 'b');
    const got: string[] = [];
    const detach = attachEngineReceiver('e1', (envelope) => got.push(envelope));
    fake.emitRaw('e1', 'c');
    expect(got).toEqual(['a', 'b', 'c']);
    detach();
    fake.emitRaw('e1', 'd');
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('bounds the buffers', () => {
    const fake = createFakeModule();
    ensureEngineEvents(fake.module);
    for (let i = 0; i < MAX_BUFFERED_PER_ENGINE + 10; i++) fake.emitRaw('busy', String(i));
    for (let i = 0; i < MAX_BUFFERED_ENGINES; i++) fake.emitRaw(`other-${i}`, 'x');
    const busy: string[] = [];
    attachEngineReceiver('busy', (e) => busy.push(e));
    // `busy` was the oldest buffered engine and was dropped when the engine-count bound was reached.
    expect(busy).toEqual([]);
    const last: string[] = [];
    attachEngineReceiver(`other-${MAX_BUFFERED_ENGINES - 1}`, (e) => last.push(e));
    expect(last).toEqual(['x']);
  });
});

describe('<MapramaView engine="native">', () => {
  it('uses the native host: init is posted to the view engine after ready', async () => {
    const fake = createFakeModule();
    setEngineModuleForTesting(fake.module);
    const onReady = jest.fn();
    await render(<MapramaView engine="native" world={{ kind: 'procedural', layout: 'town' }} onReady={onReady} testID="map" />);
    const engineId = latestEngineId();
    expect(mockViewProps[mockViewProps.length - 1]!.testID).toBe('map-engine');
    await act(async () => {
      fake.emit(engineId, READY);
    });
    await runFrames();
    await flushMicrotasks();
    const types = decodedCommands(fake, engineId).map((c) => c.type);
    expect(types[0]).toBe('init');
    expect(onReady).toHaveBeenCalledWith({ engine: READY.type === 'ready' ? READY.engine : undefined });
  });
});
