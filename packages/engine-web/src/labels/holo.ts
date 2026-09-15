/**
 * Holographic floating labels (prototype `buildHoloLabels` /
 * `updateHoloLabels`): a ground dot, a leader line and a glass card that pops
 * in (dot → line → panel), icon tiles (`white` / `black` / `color`, `auto`
 * resolved by the controller), placement with collisions and HUD exclusion
 * zones, and host-supplied custom content.
 *
 * @module
 */

import type { LabelContent, LabelContentMode } from '@maprama/protocol';
import type { CameraController } from '../core/camera.js';
import { inFront } from './dom-styles.js';
import { HOLO_ICONS, ICON_COLORS } from './icons.js';
import { HOLO_HEIGHT, holoEligible, placeHolo, resolveLabelContent, type Box, type HoloCandidate, type LabelEntry } from './index.js';

interface Holo {
  entry: LabelEntry;
  root: HTMLDivElement;
  line: HTMLElement;
  dot: HTMLElement;
  panel: HTMLDivElement;
  card: HTMLDivElement;
  ico: HTMLSpanElement;
  b: HTMLElement;
  sm: HTMLElement;
  on: boolean;
  w: number;
  h: number;
  hideT: number;
  key: string;
}

export class HoloLabels {
  private holos: Holo[] = [];

  constructor(private readonly layer: HTMLElement) {}

  build(entries: readonly LabelEntry[]): void {
    this.clear();
    const doc = this.layer.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
      const e = doc.createElement(tag);
      e.className = cls;
      return e;
    };
    for (const e of entries) {
      const root = el('div', `mpr-hl mpr-hl-${e.kind}`);
      root.dataset.labelId = e.id;
      const line = el('i', 'mpr-hl-line'), dot = el('i', 'mpr-hl-dot'), panel = el('div', 'mpr-hl-panel'), card = el('div', 'mpr-hl-card');
      const ico = el('span', 'mpr-hl-ico'), txt = el('span', 'mpr-hl-txt'), b = doc.createElement('b'), sm = doc.createElement('small');
      txt.append(b, sm);
      card.append(ico, txt);
      panel.append(card);
      root.append(line, dot, panel);
      root.style.display = 'none';
      this.layer.appendChild(root);
      this.holos.push({ entry: e, root, line, dot, panel, card, ico, b, sm, on: false, w: 0, h: 0, hideT: 0, key: '' });
    }
  }

  /** Forces re-measuring and re-applying content. */
  invalidate(): void {
    for (const h of this.holos) { h.w = 0; h.key = ''; }
  }

  hide(): void {
    for (const h of this.holos) {
      if (h.on) { h.root.classList.remove('on'); h.on = false; }
      if (h.root.style.display !== 'none') h.root.style.display = 'none';
    }
  }

  update(cam: CameraController, mode: LabelContentMode, entries: Readonly<Record<string, LabelContent>>, exclusions: readonly Box[], groundY: number, now: number): void {
    const tx = cam.orbit.x, tz = cam.orbit.z, dist = cam.orbit.distance, W = cam.width, H = cam.height;
    const cands: HoloCandidate[] = [];
    const ground = new Map<string, { x: number; y: number }>();
    for (const h of this.holos) {
      const e = h.entry, dT = Math.hypot(e.x - tx, e.z - tz);
      const eligible = holoEligible(e.kind, dT, dist);
      let onScreen = false, top = { x: 0, y: 0 };
      if (eligible) {
        this.applyContent(h, mode, entries);
        const g = cam.worldToScreen(e.x, groundY, e.z), t = cam.worldToScreen(e.x, groundY + HOLO_HEIGHT[e.kind], e.z);
        onScreen = inFront(cam, e.x, e.z) && t.x >= -0.01 * W && t.x <= 1.01 * W && t.y >= 0.01 * H && t.y <= 0.99 * H;
        top = { x: t.x, y: t.y };
        ground.set(e.id, { x: g.x, y: g.y });
        if (onScreen && !h.w) {
          h.root.style.display = '';
          h.w = h.card.offsetWidth;
          h.h = h.card.offsetHeight;
        }
        // keep the whole card inside the viewport horizontally (the prototype only checked the anchor)
        if (onScreen && h.w && (t.x - h.w / 2 < 4 || t.x + h.w / 2 > W - 4)) onScreen = false;
      }
      cands.push({ id: e.id, kind: e.kind, pri: e.pri, dT, eligible, top, onScreen, w: h.w, h: h.h });
    }
    const shown = placeHolo(cands, exclusions);
    for (const h of this.holos) {
      const box = shown.get(h.entry.id);
      if (box) {
        const g = ground.get(h.entry.id)!, c = cands.find((q) => q.id === h.entry.id)!;
        const px = c.top.x, py = c.top.y;
        h.dot.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px)`;
        h.line.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px) rotate(${Math.atan2(py - g.y, px - g.x).toFixed(3)}rad)`;
        h.line.style.width = `${Math.hypot(px - g.x, py - g.y).toFixed(1)}px`;
        h.panel.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, calc(-100% - 2px))`;
        if (!h.on) {
          h.root.style.display = '';
          void h.root.offsetWidth;
          h.root.classList.add('on');
          h.on = true;
        }
      } else if (h.on) {
        h.root.classList.remove('on');
        h.on = false;
        h.hideT = now;
      } else if (h.root.style.display !== 'none' && now - h.hideT > 320) h.root.style.display = 'none';
    }
  }

  /** Ids currently shown (for tests / tooling). */
  shownIds(): string[] {
    return this.holos.filter((h) => h.on).map((h) => h.entry.id);
  }

  private applyContent(h: Holo, mode: LabelContentMode, entries: Readonly<Record<string, LabelContent>>): void {
    const c = resolveLabelContent(h.entry, mode, entries);
    const key = `${c.title}|${c.subtitle}|${c.icon}|${c.showIcon}|${c.showSubtitle}|${c.custom}`;
    if (key === h.key) return;
    if (h.key) {
      const [pt, ps] = h.key.split('|');
      if (pt !== c.title || Math.abs((ps ?? '').length - c.subtitle.length) > 1) h.w = 0;
    } else h.w = 0;
    h.key = key;
    h.b.textContent = c.title;
    h.sm.textContent = c.subtitle;
    h.sm.style.display = c.showSubtitle && c.subtitle ? '' : 'none';
    h.ico.style.display = c.showIcon ? '' : 'none';
    h.ico.style.setProperty('--c', ICON_COLORS[c.icon]);
    h.ico.innerHTML = HOLO_ICONS[c.icon];
    h.card.classList.toggle('mpr-hl-textonly', !c.showIcon);
    h.card.classList.toggle('mpr-hl-custom', c.custom);
    h.w = 0;
  }

  clear(): void {
    for (const h of this.holos) h.root.remove();
    this.holos = [];
  }
}
