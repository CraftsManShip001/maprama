/**
 * Pointer / touch / wheel gestures (prototype camera input): one-finger pan,
 * right-button or modifier drag to rotate/pitch, two-finger pinch + twist +
 * vertical pitch, wheel zoom, and tap.
 *
 * @module
 */

import { clamp, DEG } from '../util/math.js';
import { DIST_MAX, DIST_MIN, PITCH_MAX, PITCH_MIN, type CameraController } from './camera.js';

export interface GestureHandlers {
  /** Tap at CSS pixel coordinates relative to the element. */
  onTap(x: number, y: number): void;
  /** Called when the user starts interacting (e.g. to stop following). */
  onInteract?(): void;
}

type Gesture =
  | { type: 'maybe' | 'pan' | 'rotate'; sx: number; sy: number; lx: number; ly: number; rotate: boolean }
  | { type: 'two'; len: number; ang: number; midY: number; dist0: number; bearing0: number; pitch0: number };

export class GestureController {
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private readonly off: (() => void)[] = [];

  constructor(private readonly el: HTMLElement, private readonly cam: CameraController, private readonly handlers: GestureHandlers) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn, opts);
      this.off.push(() => el.removeEventListener(type, fn, opts));
    };
    on('contextmenu', (e) => e.preventDefault());
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.end(e));
    on('pointercancel', (e) => this.end(e));
    on('wheel', (e) => {
      e.preventDefault();
      this.cam.zoomTo(clamp(this.cam.orbit.distance * (1 + e.deltaY * 0.0012), DIST_MIN, DIST_MAX));
    }, { passive: false });
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private twoInfo(): Gesture {
    const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const o = this.cam.orbit;
    return { type: 'two', len: Math.hypot(b.x - a.x, b.y - a.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x), midY: (a.y + b.y) / 2, dist0: o.distance, bearing0: o.bearing, pitch0: o.pitch };
  }

  private down(e: PointerEvent): void {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.handlers.onInteract?.();
    if (this.pointers.size === 1) {
      this.gesture = { type: 'maybe', sx: p.x, sy: p.y, lx: p.x, ly: p.y, rotate: e.button === 2 || e.shiftKey || e.altKey || e.ctrlKey };
    } else if (this.pointers.size === 2) this.gesture = this.twoInfo();
  }

  private move(e: PointerEvent): void {
    const g = this.gesture;
    if (!this.pointers.has(e.pointerId) || !g) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (g.type === 'two') {
      if (this.pointers.size < 2) return;
      const n = this.twoInfo() as Extract<Gesture, { type: 'two' }>;
      this.cam.zoomTo(clamp((g.dist0 * g.len) / n.len, DIST_MIN, DIST_MAX));
      const o = this.cam.orbit;
      this.cam.rotateBy(g.bearing0 + (n.ang - g.ang) / DEG - o.bearing, clamp(g.pitch0 - (n.midY - g.midY) * 0.3, PITCH_MIN, PITCH_MAX) - o.pitch);
      return;
    }
    if (g.type === 'maybe' && Math.hypot(p.x - g.sx, p.y - g.sy) > 6) g.type = g.rotate ? 'rotate' : 'pan';
    if (g.type === 'pan') {
      const a = this.cam.screenToGround(g.lx, g.ly);
      const b = this.cam.screenToGround(p.x, p.y);
      if (a && b) { this.cam.panBy(a.x - b.x, a.z - b.z); this.cam.apply(); }
    } else if (g.type === 'rotate') {
      this.cam.rotateBy((p.x - g.lx) * 0.35, -(p.y - g.ly) * 0.3);
      this.cam.apply();
    }
    g.lx = p.x;
    g.ly = p.y;
  }

  private end(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const g = this.gesture;
    const wasTap = !!g && g.type === 'maybe' && this.pointers.size === 1 && e.type === 'pointerup';
    this.pointers.delete(e.pointerId);
    if (wasTap) {
      const p = this.local(e);
      this.handlers.onTap(p.x, p.y);
    }
    if (this.pointers.size === 1) {
      const p = [...this.pointers.values()][0]!;
      this.gesture = { type: 'pan', sx: p.x, sy: p.y, lx: p.x, ly: p.y, rotate: false };
    } else if (this.pointers.size === 0) this.gesture = null;
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
  }
}
