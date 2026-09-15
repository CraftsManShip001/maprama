/**
 * Per-frame command batching with spec diffing for declarative children.
 *
 * Children register specs synchronously (cheap, no bridge traffic); at most
 * once per animation frame the batcher diffs the merged state against what was
 * last sent and emits at most one command per kind: `removeCharacters`,
 * `upsertCharacters`, `setDropLayer`/`removeDropLayer` (per changed layer),
 * `setGeofences`, `setOverlayAnchors` and `setLabelContent`.
 *
 * @module
 */

import type {
  CharacterSpec,
  DropSpec,
  EngineCommand,
  GeofenceSpec,
  LabelContent,
  OverlayAnchor,
} from '@maprama/protocol';

/** Schedules a callback for the next frame. */
export type FrameScheduler = (callback: () => void) => void;

let frameSchedulerOverride: FrameScheduler | null = null;

/**
 * @internal Test-only: replaces the frame scheduler used by every batcher created
 * without an explicit `schedule` (e.g. by `MapramaView`), so tests can run frames
 * deterministically. Pass `null` to restore `requestAnimationFrame`.
 */
export function setFrameSchedulerForTesting(scheduler: FrameScheduler | null): void {
  frameSchedulerOverride = scheduler;
}

/** Next animation frame, or a 16 ms timer where `requestAnimationFrame` is missing. */
export const defaultFrameScheduler: FrameScheduler = (callback) => {
  if (frameSchedulerOverride) {
    frameSchedulerOverride(callback);
    return;
  }
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf === 'function') raf(callback);
  else setTimeout(callback, 16);
};

/** Drop layer state as sent with `setDropLayer`. */
export interface DropLayerState {
  drops: DropSpec[];
  collectRadiusMeters: number;
  collectorIds?: string[];
}

interface BatcherOptions {
  /** Receives the batched commands. */
  sink: (command: EngineCommand) => void;
  /** Whether frame flushes may send now (before the engine is ready they wait). */
  canFlush: () => boolean;
  schedule?: FrameScheduler;
}

const json = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

/** Collects child specs and flushes minimal commands once per frame. */
export class CommandBatcher {
  private readonly sink: (command: EngineCommand) => void;
  private readonly canFlush: () => boolean;
  private readonly schedule: FrameScheduler;

  private readonly characterSources = new Map<string, { specs: CharacterSpec[]; json: string }>();
  private readonly dropLayers = new Map<string, { state: DropLayerState; json: string }>();
  private readonly geofences = new Map<string, GeofenceSpec>();
  private readonly overlays = new Map<string, OverlayAnchor>();
  private labelContent: Record<string, LabelContent> | null = null;

  private sentCharacters = new Map<string, string>();
  /** Character ids whose last upsert carried a model (a later spec without one must clear it). */
  private sentWithModel = new Set<string>();
  private sentDropLayers = new Map<string, string>();
  private sentGeofences = '[]';
  private sentOverlays = '[]';
  private sentLabelContent: string | null = null;

  private dirty = false;
  private scheduled = false;
  private disposed = false;

  private playerId: string | null = null;
  private readonly playerListeners = new Set<() => void>();

  constructor(options: BatcherOptions) {
    this.sink = options.sink;
    this.canFlush = options.canFlush;
    this.schedule = options.schedule ?? defaultFrameScheduler;
  }

  // -- characters ----------------------------------------------------------

  /** Sets the characters contributed by one source (a `Character` or `CharacterLayer`). */
  setCharacters(sourceKey: string, specs: CharacterSpec[]): void {
    const next = json(specs);
    if (this.characterSources.get(sourceKey)?.json === next) return;
    this.characterSources.set(sourceKey, { specs, json: next });
    this.updatePlayer();
    this.markDirty();
  }

  /** Removes every character of a source. */
  removeCharacterSource(sourceKey: string): void {
    if (!this.characterSources.delete(sourceKey)) return;
    this.updatePlayer();
    this.markDirty();
  }

  /** Id of the registered `isPlayer` character, or `null`. */
  getPlayerId = (): string | null => this.playerId;

  /** Subscribes to player id changes (for `useSyncExternalStore`). */
  subscribePlayer = (listener: () => void): (() => void) => {
    this.playerListeners.add(listener);
    return () => {
      this.playerListeners.delete(listener);
    };
  };

  // -- drops ---------------------------------------------------------------

  /** Creates or replaces a drop layer. */
  setDropLayer(layerId: string, state: DropLayerState): void {
    const next = json(state);
    if (this.dropLayers.get(layerId)?.json === next) return;
    this.dropLayers.set(layerId, { state, json: next });
    this.markDirty();
  }

  /** Removes a drop layer. */
  removeDropLayer(layerId: string): void {
    if (!this.dropLayers.delete(layerId)) return;
    this.markDirty();
  }

  // -- geofences / overlays / labels --------------------------------------

  setGeofence(spec: GeofenceSpec): void {
    const prev = this.geofences.get(spec.id);
    if (prev && json(prev) === json(spec)) return;
    this.geofences.set(spec.id, spec);
    this.markDirty();
  }

  removeGeofence(id: string): void {
    if (!this.geofences.delete(id)) return;
    this.markDirty();
  }

  setOverlayAnchor(anchor: OverlayAnchor): void {
    const prev = this.overlays.get(anchor.id);
    if (prev && json(prev) === json(anchor)) return;
    this.overlays.set(anchor.id, anchor);
    this.markDirty();
  }

  removeOverlayAnchor(id: string): void {
    if (!this.overlays.delete(id)) return;
    this.markDirty();
  }

  /** Sets host label content (sent only when it differs from the last sent entries). */
  setLabelContent(entries: Record<string, LabelContent>): void {
    this.labelContent = entries;
    this.markDirty();
  }

  // -- flushing ------------------------------------------------------------

  /** Forgets what was sent so the next flush re-sends the full state (after an engine reload). */
  resetSent(): void {
    this.sentCharacters = new Map();
    this.sentWithModel = new Set();
    this.sentDropLayers = new Map();
    this.sentGeofences = '[]';
    this.sentOverlays = '[]';
    this.sentLabelContent = null;
    this.dirty = true;
  }

  /** Sends pending changes immediately (used before imperative commands to keep causal order). */
  flushNow(): void {
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    this.flushCharacters();
    this.flushDropLayers();
    this.flushGeofences();
    this.flushOverlays();
    this.flushLabelContent();
  }

  /** Stops scheduling; pending changes are dropped. */
  dispose(): void {
    this.disposed = true;
    this.playerListeners.clear();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (this.canFlush()) this.flushNow();
    });
  }

  private updatePlayer(): void {
    let player: string | null = null;
    for (const { specs } of this.characterSources.values()) {
      for (const spec of specs) if (spec.isPlayer) player = spec.id;
    }
    if (player === this.playerId) return;
    this.playerId = player;
    for (const listener of [...this.playerListeners]) listener();
  }

  private flushCharacters(): void {
    const merged = new Map<string, CharacterSpec>();
    for (const { specs } of this.characterSources.values()) for (const spec of specs) merged.set(spec.id, spec);
    const removed = [...this.sentCharacters.keys()].filter((id) => !merged.has(id));
    for (const id of removed) {
      this.sentCharacters.delete(id);
      this.sentWithModel.delete(id);
    }
    const upserts: CharacterSpec[] = [];
    for (const [id, spec] of merged) {
      const next = json(spec);
      if (this.sentCharacters.get(id) === next) continue;
      this.sentCharacters.set(id, next);
      // The engine merges upserts into its copy, so a model that was sent before is cleared explicitly.
      const hadModel = this.sentWithModel.has(id);
      if (spec.model) this.sentWithModel.add(id);
      else this.sentWithModel.delete(id);
      upserts.push(!spec.model && hadModel ? { ...spec, model: null } : spec);
    }
    if (removed.length) this.sink({ type: 'removeCharacters', ids: removed });
    if (upserts.length) this.sink({ type: 'upsertCharacters', characters: upserts });
  }

  private flushDropLayers(): void {
    for (const layerId of [...this.sentDropLayers.keys()]) {
      if (this.dropLayers.has(layerId)) continue;
      this.sentDropLayers.delete(layerId);
      this.sink({ type: 'removeDropLayer', layerId });
    }
    for (const [layerId, { state, json: next }] of this.dropLayers) {
      if (this.sentDropLayers.get(layerId) === next) continue;
      this.sentDropLayers.set(layerId, next);
      this.sink({
        type: 'setDropLayer',
        layerId,
        drops: state.drops,
        collectRadiusMeters: state.collectRadiusMeters,
        ...(state.collectorIds ? { collectorIds: state.collectorIds } : {}),
      });
    }
  }

  private flushGeofences(): void {
    const geofences = [...this.geofences.values()];
    const next = json(geofences);
    if (next === this.sentGeofences) return;
    this.sentGeofences = next;
    this.sink({ type: 'setGeofences', geofences });
  }

  private flushOverlays(): void {
    const anchors = [...this.overlays.values()];
    const next = json(anchors);
    if (next === this.sentOverlays) return;
    this.sentOverlays = next;
    this.sink({ type: 'setOverlayAnchors', anchors });
  }

  private flushLabelContent(): void {
    if (!this.labelContent) return;
    const next = json(this.labelContent);
    if (next === this.sentLabelContent) return;
    this.sentLabelContent = next;
    this.sink({ type: 'setLabelContent', entries: this.labelContent });
  }
}

/**
 * Leading + trailing throttle: the first call runs immediately, later calls
 * within `ms` collapse into one trailing call with the latest arguments.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): { call: (...args: A) => void; cancel: () => void } {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = (args: A): void => {
    last = Date.now();
    fn(...args);
  };
  return {
    call(...args) {
      if (ms <= 0) {
        fn(...args);
        return;
      }
      const wait = last + ms - Date.now();
      if (wait <= 0 && !timer) {
        run(args);
        return;
      }
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) {
            const next = pending;
            pending = null;
            run(next);
          }
        }, Math.max(0, wait));
      }
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
