/**
 * Zoom buttons (prototype `#zoomIn` / `#zoomOut`): ±1.45× camera distance,
 * accessible buttons with 44px targets.
 *
 * @module
 */

import type { CameraController } from '../core/camera.js';

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
        // `gesture`, not `api`: the user pressed this, the host never issued it. `camera:idle.reason`
        // exists so an app can tell the moves it made itself from the ones it has to react to.
        this.cam.set({ distance: this.cam.clampDistance(this.cam.orbit.distance * factor) }, 250, 'gesture');
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
