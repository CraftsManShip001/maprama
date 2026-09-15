/**
 * Scale bar (prototype `stepMap` map-UI part): the largest round distance
 * that fits in 90 CSS pixels at the camera target.
 *
 * @module
 */

import type { CameraController } from '../core/camera.js';
import { DEG } from '../util/math.js';

const STEPS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** Scale bar length for a ground resolution in meters per CSS pixel. */
export function scaleBarFor(metersPerPixel: number, maxPx = 90): { meters: number; px: number; text: string } {
  let v = STEPS[0]!;
  for (const n of STEPS) if (n / metersPerPixel <= maxPx) v = n;
  return { meters: v, px: v / metersPerPixel, text: v >= 1000 ? `${v / 1000}km` : `${v}m` };
}

/** Meters per CSS pixel at the camera target. */
export function metersPerPixel(cam: CameraController, unitMeters: number): number {
  return ((2 * cam.orbit.distance * Math.tan((cam.camera.fov * DEG) / 2)) / Math.max(1, cam.height)) * unitMeters;
}

export class ScaleBar {
  readonly el: HTMLDivElement;
  private readonly line: HTMLElement;
  private readonly text: HTMLElement;
  private last = '';

  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument;
    this.el = doc.createElement('div');
    this.el.className = 'mpr-scalebar';
    this.el.setAttribute('aria-hidden', 'true');
    this.text = doc.createElement('span');
    this.line = doc.createElement('i');
    this.el.append(this.text, this.line);
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  update(visible: boolean, cam: CameraController, unitMeters: number): void {
    this.el.hidden = !visible;
    if (!visible) return;
    const s = scaleBarFor(metersPerPixel(cam, unitMeters));
    const key = `${s.text}|${s.px.toFixed(1)}`;
    if (key === this.last) return;
    this.last = key;
    this.line.style.width = `${s.px.toFixed(1)}px`;
    this.text.textContent = s.text;
  }

  dispose(): void {
    this.el.remove();
  }
}
