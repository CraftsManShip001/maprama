/**
 * Zoom buttons (prototype `#zoomIn` / `#zoomOut`): ±1.45× camera distance,
 * accessible buttons with 44px targets.
 *
 * @module
 */

import { DIST_MAX, DIST_MIN, type CameraController } from '../core/camera.js';
import { clamp } from '../util/math.js';

export const ZOOM_STEP = 1.45;

export class ZoomButtons {
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly cam: CameraController) {
    const doc = parent.ownerDocument;
    this.el = doc.createElement('div');
    this.el.className = 'mpr-zoombtns';
    const btn = (label: string, text: string, factor: number): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'mpr-zb';
      b.setAttribute('aria-label', label);
      b.textContent = text;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cam.set({ distance: clamp(this.cam.orbit.distance * factor, DIST_MIN, DIST_MAX) }, 250);
      });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    this.el.append(btn('Zoom in', '+', 1 / ZOOM_STEP), btn('Zoom out', '−', ZOOM_STEP));
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  update(visible: boolean): void {
    this.el.hidden = !visible;
  }

  dispose(): void {
    this.el.remove();
  }
}
