/**
 * DOM mood overlays layered over the canvas: sky haze, vignette, cinematic
 * color grade and golden-hour light rays (prototype `#haze`, `#vignette`,
 * `#grade`, `#rays`), plus the empty overlay layer part 2 draws labels / map
 * UI into.
 *
 * @module
 */

import type { RenderParams } from './params.js';

const STYLE_ID = 'maprama-engine-style';
const CSS = `
.mpr-root{position:relative;overflow:hidden;isolation:isolate;touch-action:none;-webkit-user-select:none;user-select:none}
.mpr-root>canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}
.mpr-haze,.mpr-vignette,.mpr-grade{position:absolute;inset:0;pointer-events:none;z-index:1}
.mpr-grade{mix-blend-mode:soft-light}
.mpr-rays{position:absolute;inset:-20%;pointer-events:none;z-index:1;mix-blend-mode:screen;background:repeating-linear-gradient(118deg,rgba(255,214,150,0) 0 46px,rgba(255,214,150,.26) 46px 80px,rgba(255,214,150,0) 80px 150px);-webkit-mask-image:radial-gradient(70% 60% at 85% 12%,#000 0%,rgba(0,0,0,.45) 45%,transparent 75%);mask-image:radial-gradient(70% 60% at 85% 12%,#000 0%,rgba(0,0,0,.45) 45%,transparent 75%);filter:blur(5px);animation:mpr-rays 14s ease-in-out infinite alternate}
.mpr-rays[hidden]{display:none}
.mpr-overlay{position:absolute;inset:0;pointer-events:none;z-index:3}
@keyframes mpr-rays{from{transform:translateX(-18px)}to{transform:translateX(18px)}}
@media (prefers-reduced-motion: reduce){.mpr-rays{animation:none}}
.mpr-reduce-motion .mpr-rays{animation:none}
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
    this.haze = div('mpr-haze');
    this.vignette = div('mpr-vignette');
    this.grade = div('mpr-grade');
    this.rays = div('mpr-rays');
    this.rays.hidden = true;
    this.layer = div('mpr-overlay');
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
