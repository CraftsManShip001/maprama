import { beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';
import { decodeCommand, encodeEvent, type EngineCommand, type EngineEvent } from '@maprama/protocol';
import { setFrameSchedulerForTesting } from '../batching';
import { webViewInstances, type FakeWebViewInstance } from '../../jest/react-native-webview';

export { webViewInstances };

/** A `ready` event from the web engine. */
export const READY: EngineEvent = { type: 'ready', engine: { name: 'maprama-web', version: '0.0.0-test', kind: 'web' } };

/** The most recently mounted fake WebView. */
export function latestWebView(): FakeWebViewInstance {
  const instance = webViewInstances[webViewInstances.length - 1];
  if (!instance) throw new Error('no WebView mounted');
  return instance;
}

/** Decodes (and validates against the protocol) every command posted to the WebView. */
export function commands(instance: FakeWebViewInstance = latestWebView()): EngineCommand[] {
  return instance.posted.map((raw) => {
    const decoded = decodeCommand(raw);
    if (!decoded.ok) throw new Error(`host posted an invalid command: ${decoded.error}\n${raw}`);
    return decoded.value.msg;
  });
}

/** Command types posted so far. */
export function commandTypes(instance: FakeWebViewInstance = latestWebView()): string[] {
  return commands(instance).map((c) => c.type);
}

/** Commands of one type. */
export function commandsOf<T extends EngineCommand['type']>(type: T, instance?: FakeWebViewInstance): Extract<EngineCommand, { type: T }>[] {
  return commands(instance).filter((c): c is Extract<EngineCommand, { type: T }> => c.type === type);
}

/** Forgets posted commands. */
export function clearPosted(instance: FakeWebViewInstance = latestWebView()): void {
  instance.posted.length = 0;
}

let seq = 0;

/** Delivers a raw `onMessage` payload as if the engine posted it. */
export async function emitRaw(data: unknown, instance: FakeWebViewInstance = latestWebView()): Promise<void> {
  await act(async () => {
    (instance.props.onMessage as (e: { nativeEvent: { data: unknown } }) => void)({ nativeEvent: { data } });
  });
}

/** Encodes and delivers one engine event. */
export async function emit(event: EngineEvent, instance?: FakeWebViewInstance): Promise<void> {
  await emitRaw(encodeEvent(event, seq++), instance);
}

// Frames never run on their own in tests: batchers queue their flush here and
// tests run it explicitly with `nextFrame()`, so assertions never race a timer.
const frameQueue: (() => void)[] = [];
setFrameSchedulerForTesting((callback) => {
  frameQueue.push(callback);
});
beforeEach(() => {
  frameQueue.length = 0;
});

/** Number of frame callbacks waiting to run. */
export function pendingFrames(): number {
  return frameQueue.length;
}

/** Runs every scheduled frame flush (and frames they schedule) plus pending promises, inside act. */
export async function nextFrame(): Promise<void> {
  await act(async () => {
    for (let guard = 0; frameQueue.length > 0 && guard < 100; guard++) {
      for (const callback of frameQueue.splice(0)) callback();
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Resolves pending microtasks (e.g. mocked fetch chains) inside act. Does not advance timers. */
export async function flushPromises(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
