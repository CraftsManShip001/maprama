/**
 * DOM mood overlays layered over the canvas: sky haze, vignette, cinematic
 * color grade and golden-hour light rays (prototype `#haze`, `#vignette`,
 * `#grade`, `#rays`), plus the empty overlay layer part 2 draws labels / map
 * UI into.
 *
 * @module
 */

import type { RenderParams } from './params.js';

const STYLE_ID = 'diorama-engine-style';
const CSS = `
.dio-root{position:relative;overflow:hidden;isolation:isolate;touch-action:none;-webkit-user-select:none;user-select:none}
.dio-root>canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
.dio-haze,.dio-vignette,.dio-grade{position:absolute;inset:0;pointer-events:none;z-index:1}
.dio-grade{mix-blend-mode:soft-light}
.dio-rays{position:absolute;inset:-20%;pointer-events:none;z-index:1;mix-blend-mode:screen;background:repeating-linear-gradient(118deg,rgba(255,214,150,0) 0 46px,rgba(255,214,150,.26) 46px 80px,rgba(255,214,150,0) 80px 150px);-webkit-mask-image:radial-gradient(70% 60% at 85% 12%,#000 0%,rgba(0,0,0,.45) 45%,transparent 75%);mask-image:radial-gradient(70% 60% at 85% 12%,#000 0%,rgba(0,0,0,.45) 45%,transparent 75%);filter:blur(5px);animation:dio-rays 14s ease-in-out infinite alternate}
.dio-rays[hidden]{display:none}
.dio-overlay{position:absolute;inset:0;pointer-events:none;z-index:3}
@keyframes dio-rays{from{transform:translateX(-18px)}to{transform:translateX(18px)}}
@media (prefers-reduced-motion: reduce){.dio-rays{animation:none}}
.dio-reduce-motion .dio-rays{animation:none}
`;

const hexCss = (n: number): string => '#' + n.toString(16).padStart(6, '0');

export class MoodOverlays {
  readonly haze: HTMLDivElement;
  readonly vignette: HTMLDivElement;
  readonly grade: HTMLDivElement;
  readonly rays: HTMLDivElement;
  /** Layer for DOM labels / map UI (part 2). Pointer events are off by default. */
  readonly layer: HTMLDivElement;
  private hazeOpacity = 1;

  constructor(private readonly root: HTMLElement) {
    const doc = root.ownerDocument;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head.appendChild(style);
    }
    const div = (cls: string): HTMLDivElement => {
      const d = doc.createElement('div');
      d.className = cls;
      root.appendChild(d);
      return d;
    };
    this.haze = div('dio-haze');
    this.vignette = div('dio-vignette');
    this.grade = div('dio-grade');
    this.rays = div('dio-rays');
    this.rays.hidden = true;
    this.layer = div('dio-overlay');
  }

  apply(p: RenderParams): void {
    const o = p.overlays;
    this.root.style.background = hexCss(p.fog.color);
    this.haze.style.background = o.haze;
    this.vignette.style.background = o.vignette;
    this.hazeOpacity = o.hazeOpacity;
    this.haze.style.opacity = String(o.hazeOpacity);
    this.vignette.style.opacity = String(o.hazeOpacity);
    this.grade.style.background = o.grade ?? 'none';
    this.grade.style.opacity = String(o.gradeOpacity);
    this.rays.hidden = !o.rays;
  }

  /** Fades the haze while zoomed out (prototype `stepMap`). */
  setZoomFade(t: number, mapColors: boolean): void {
    this.haze.style.opacity = String(this.hazeOpacity * (1 - (mapColors ? t * 0.6 : t * 0.3)));
  }

  dispose(): void {
    for (const el of [this.haze, this.vignette, this.grade, this.rays, this.layer]) el.remove();
  }
}
