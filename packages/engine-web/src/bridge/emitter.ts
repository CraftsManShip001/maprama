/**
 * Typed event emitter for engine events.
 *
 * @module
 */

import type { EngineEvent, EngineEventType } from '@maprama/protocol';

export type EventOf<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;
export type EventListener<T extends EngineEventType> = (event: EventOf<T>) => void;
export type AnyEventListener = (event: EngineEvent) => void;

export class EventEmitter {
  private listeners = new Map<string, Set<(e: EngineEvent) => void>>();

  /** Subscribes to one event type, or `'*'` for every event. Returns an unsubscribe function. */
  on<T extends EngineEventType>(type: T, cb: EventListener<T>): () => void;
  on(type: '*', cb: AnyEventListener): () => void;
  on(type: string, cb: (e: never) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const fn = cb as unknown as (e: EngineEvent) => void;
    set.add(fn);
    return () => { set.delete(fn); };
  }

  emit(event: EngineEvent): void {
    for (const key of [event.type, '*']) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const cb of [...set]) {
        try {
          cb(event);
        } catch {
          // listener errors must never break the engine loop
        }
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
