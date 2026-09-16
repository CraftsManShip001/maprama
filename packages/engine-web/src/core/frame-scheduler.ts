/**
 * Frame scheduling for on-demand rendering.
 *
 * The render loop keeps its `requestAnimationFrame` ticking, but its body only
 * runs when this scheduler says so. Two ways to ask for frames:
 *
 * - {@link FrameScheduler.request} — "render one more frame". Idempotent: any
 *   number of requests between two ticks produce exactly one extra frame.
 * - {@link FrameScheduler.addSource} — "keep rendering until I release this".
 *   Used by anything that animates over time (characters, drops, camera
 *   easings…). Sources are reference counted per tag, so two holders of the
 *   same tag both have to release.
 *
 * This unit is pure (no DOM, no WebGL) so the scheduling decision can be
 * tested without a renderer.
 *
 * @module
 */

export class FrameScheduler {
  private pending = false;
  private readonly sources = new Map<string, number>();

  /** Renders one more frame. Idempotent until that frame runs. */
  request(): void {
    this.pending = true;
  }

  /** True while a frame is queued or at least one source is held. */
  get busy(): boolean {
    return this.pending || this.sources.size > 0;
  }

  /** True while at least one source is held (frames keep coming without new requests). */
  get continuous(): boolean {
    return this.sources.size > 0;
  }

  /** Tags currently keeping the loop awake, sorted (diagnostics and tests). */
  get tags(): string[] {
    return [...this.sources.keys()].sort();
  }

  /**
   * True when at least one held tag is **not** in `ignored`. Allocation free,
   * so it can be asked once per frame (see the shadow update policy).
   */
  hasSourceExcept(ignored: ReadonlySet<string>): boolean {
    for (const tag of this.sources.keys()) if (!ignored.has(tag)) return true;
    return false;
  }

  /** Keeps frames coming until the returned release function is called (calling it twice is a no-op). */
  addSource(tag: string): () => void {
    this.sources.set(tag, (this.sources.get(tag) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.sources.get(tag) ?? 0) - 1;
      if (n > 0) this.sources.set(tag, n);
      else this.sources.delete(tag);
    };
  }

  /**
   * Consumes the decision for one animation frame: `true` when the frame body
   * should run. A pending request is cleared (a held source is not).
   */
  take(): boolean {
    const run = this.busy;
    this.pending = false;
    return run;
  }
}
