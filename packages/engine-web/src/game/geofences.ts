/**
 * Circular geofences: enter/exit transition tracking (pure) and the
 * prototype's ring + fill + pulse visuals.
 *
 * Transition rules: a character is inside when its distance to the center is
 * strictly less than the radius. Replacing the geofence list keeps the
 * inside-state of ids that still exist (no duplicate `enter`); removed
 * geofences and removed characters are forgotten silently (no `exit`).
 *
 * @module
 */

import type { GeofenceEnterEvent, GeofenceExitEvent } from '@maprama/protocol';
import { CircleGeometry, Group, Mesh, MeshBasicMaterial, RingGeometry } from 'three';
import { ACCENT } from '../theme/materials.js';

/** A geofence in world units. */
export interface WorldFence {
  id: string;
  x: number;
  z: number;
  /** Radius in world units. */
  r: number;
}

export type GeofenceEvent = GeofenceEnterEvent | GeofenceExitEvent;

/** Tracks which characters are inside which geofences. */
export class GeofenceTracker {
  private fences: WorldFence[] = [];
  private inside = new Map<string, Set<string>>();

  set(fences: WorldFence[]): void {
    this.fences = fences.map((f) => ({ ...f }));
    const next = new Map<string, Set<string>>();
    for (const f of this.fences) next.set(f.id, this.inside.get(f.id) ?? new Set());
    this.inside = next;
  }

  list(): readonly WorldFence[] {
    return this.fences;
  }

  /** Evaluates positions; returns transitions in fence order, then character order. */
  update(characters: readonly { id: string; x: number; z: number }[]): GeofenceEvent[] {
    const events: GeofenceEvent[] = [];
    const present = new Set(characters.map((c) => c.id));
    for (const f of this.fences) {
      const set = this.inside.get(f.id)!;
      for (const id of [...set]) if (!present.has(id)) set.delete(id);
      for (const c of characters) {
        const now = Math.hypot(c.x - f.x, c.z - f.z) < f.r;
        if (now === set.has(c.id)) continue;
        if (now) {
          set.add(c.id);
          events.push({ type: 'geofence:enter', geofenceId: f.id, characterId: c.id });
        } else {
          set.delete(c.id);
          events.push({ type: 'geofence:exit', geofenceId: f.id, characterId: c.id });
        }
      }
    }
    return events;
  }

  isInside(geofenceId: string, characterId: string): boolean {
    return !!this.inside.get(geofenceId)?.has(characterId);
  }
}

/** Ring, translucent fill and expanding pulse per geofence (prototype visuals). */
export class GeofenceVisuals {
  readonly group = new Group();
  private items: { pulse: Mesh; pulseMat: MeshBasicMaterial; r: number }[] = [];
  private mats: MeshBasicMaterial[] = [];

  constructor() {
    this.group.name = 'geofences';
  }

  /**
   * True while the pulse rings animate. With reduced motion the pulse is
   * hidden and frozen, so they need no frames at all.
   */
  animating(reduceMotion: boolean): boolean {
    return !reduceMotion && this.items.length > 0;
  }

  build(fences: readonly WorldFence[], groundY: number): void {
    this.clear();
    const ring = new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, depthWrite: false });
    const fill = new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.07, depthWrite: false });
    this.mats.push(ring, fill);
    for (const f of fences) {
      const w = Math.min(0.35, f.r * 0.2);
      const rm = new Mesh(new RingGeometry(Math.max(0.01, f.r - w), f.r, 80).rotateX(-Math.PI / 2), ring);
      rm.position.set(f.x, groundY + 0.11, f.z);
      const fm = new Mesh(new CircleGeometry(Math.max(0.01, f.r - w), 80).rotateX(-Math.PI / 2), fill);
      fm.position.set(f.x, groundY + 0.1, f.z);
      const pulseMat = new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5, depthWrite: false });
      this.mats.push(pulseMat);
      const pulse = new Mesh(new RingGeometry(0.93, 1, 80).rotateX(-Math.PI / 2), pulseMat);
      pulse.position.set(f.x, groundY + 0.12, f.z);
      for (const m of [rm, fm, pulse]) { m.renderOrder = 4; m.raycast = () => {}; }
      this.group.add(rm, fm, pulse);
      this.items.push({ pulse, pulseMat, r: f.r });
    }
  }

  step(t: number, reduceMotion: boolean): void {
    const s = reduceMotion ? 1 : (t * 0.45) % 1;
    for (const it of this.items) {
      it.pulse.scale.setScalar(Math.max(0.01, it.r * 0.987 * s));
      it.pulseMat.opacity = reduceMotion ? 0 : (1 - s) * 0.55;
      it.pulse.visible = !reduceMotion;
    }
  }

  clear(): void {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as Mesh).geometry?.dispose();
    }
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.items = [];
  }
}
