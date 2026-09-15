/**
 * Routes `MapramaEngineModule.onEngineEvent` emissions to the host of each engine.
 *
 * One module-wide subscription is created (lazily, during the first host render) so no event is lost
 * between the native view mounting (its engine emits `ready` right away) and the host's effect
 * attaching its receiver: events for engine ids without a receiver are buffered (bounded) and replayed
 * on attach.
 *
 * @module
 */

import type { Spec } from './specs/NativeMapramaEngineModule';

/** Envelopes kept per engine id while no receiver is attached. */
export const MAX_BUFFERED_PER_ENGINE = 256;
/** Engine ids with buffered envelopes (oldest dropped first). */
export const MAX_BUFFERED_ENGINES = 16;

type Receiver = (envelope: string) => void;

const receivers = new Map<string, Receiver>();
const buffered = new Map<string, string[]>();
let subscribedModule: Spec | null = null;
let subscription: { remove(): void } | null = null;

function deliver(engineId: string, envelope: string): void {
  const receiver = receivers.get(engineId);
  if (receiver) {
    receiver(envelope);
    return;
  }
  let queue = buffered.get(engineId);
  if (!queue) {
    if (buffered.size >= MAX_BUFFERED_ENGINES) {
      const oldest = buffered.keys().next().value;
      if (oldest !== undefined) buffered.delete(oldest);
    }
    queue = [];
    buffered.set(engineId, queue);
  }
  if (queue.length < MAX_BUFFERED_PER_ENGINE) queue.push(envelope);
}

/** Subscribes to the module's engine events once (idempotent per module instance). */
export function ensureEngineEvents(module: Spec): void {
  if (subscribedModule === module && subscription) return;
  subscription?.remove();
  subscribedModule = module;
  subscription = module.onEngineEvent((message) => {
    if (message && typeof message.engineId === 'string' && typeof message.envelope === 'string') {
      deliver(message.engineId, message.envelope);
    }
  });
}

/** Attaches the receiver of `engineId`, replays buffered envelopes, returns the detach function. */
export function attachEngineReceiver(engineId: string, receiver: Receiver): () => void {
  receivers.set(engineId, receiver);
  const queue = buffered.get(engineId);
  buffered.delete(engineId);
  if (queue) for (const envelope of queue) receiver(envelope);
  return () => {
    if (receivers.get(engineId) === receiver) receivers.delete(engineId);
    buffered.delete(engineId);
  };
}

/** @internal Test hook: forgets the subscription, receivers and buffers. */
export function resetEngineEventsForTesting(): void {
  subscription?.remove();
  subscription = null;
  subscribedModule = null;
  receivers.clear();
  buffered.clear();
}
