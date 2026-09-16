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
import { clampLabelX, HOLO_HEIGHT, holoEligible, placeHolo, resolveLabelContent, type Box, type HoloCandidate, type LabelEntry } from './index.js';

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

/** Milliseconds a hidden card stays in the layout so its fade-out transition can play. */
const HIDE_MS = 320;

export class HoloLabels {
  private holos: Holo[] = [];

  constructor(private readonly layer: HTMLElement) {}

  /**
   * True while a card is fading out: it needs one more update, at least
   * {@link HIDE_MS} after it was hidden, to set `display: none`. Without this
   * the on-demand loop would go idle first and leave the card in the layout.
   */
  get animating(): boolean {
    return this.holos.some((h) => !h.on && h.root.style.display !== 'none');
  }

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

  /**
   * @param heightScale How much of the hologram's stalk is drawn (1 = 2.5D,
   *   0 = the flat 2D view, where a card sits flat on its own coordinate).
   */
  update(cam: CameraController, mode: LabelContentMode, entries: Readonly<Record<string, LabelContent>>, exclusions: readonly Box[], groundY: number, now: number, heightScale = 1): void {
    const tx = cam.orbit.x, tz = cam.orbit.z, dist = cam.orbit.distance;
    const v = cam.view, X0 = v.x, Y0 = v.y, W = v.width, H = v.height;
    const cands: HoloCandidate[] = [];
    // true anchors: the ground dot and the top of the leader line
    const anchors = new Map<string, { gx: number; gy: number; tx: number }>();
    for (const h of this.holos) {
      const e = h.entry, dT = Math.hypot(e.x - tx, e.z - tz);
      const eligible = holoEligible(e.kind, dT, dist);
      let onScreen = false, top = { x: 0, y: 0 };
      if (eligible) {
        this.applyContent(h, mode, entries);
        const g = cam.worldToScreen(e.x, groundY, e.z), t = cam.worldToScreen(e.x, groundY + HOLO_HEIGHT[e.kind] * heightScale, e.z);
        onScreen = inFront(cam, e.x, e.z) && t.x >= X0 - 0.01 * W && t.x <= X0 + 1.01 * W && t.y >= Y0 + 0.01 * H && t.y <= Y0 + 0.99 * H;
        anchors.set(e.id, { gx: g.x, gy: g.y, tx: t.x });
        if (onScreen && !h.w) {
          h.root.style.display = '';
          h.w = h.card.offsetWidth;
          h.h = h.card.offsetHeight;
        }
        // keep the whole card inside the viewport horizontally: the panel slides along the edge
        // (the dot and the leader line stay at the true anchor)
        top = { x: h.w ? clampLabelX(t.x, h.w / 2, W, undefined, X0) : t.x, y: t.y };
      }
      cands.push({ id: e.id, kind: e.kind, pri: e.pri, dT, eligible, top, onScreen, w: h.w, h: h.h });
    }
    const shown = placeHolo(cands, exclusions);
    for (const h of this.holos) {
      const box = shown.get(h.entry.id);
      if (box) {
        const a = anchors.get(h.entry.id)!, c = cands.find((q) => q.id === h.entry.id)!;
        const g = { x: a.gx, y: a.gy };
        // panel position; the line ends at the true anchor, kept under the (possibly shifted) panel
        const px = c.top.x, py = c.top.y, inset = Math.min(10, h.w / 2);
        const lx = Math.min(px + h.w / 2 - inset, Math.max(px - h.w / 2 + inset, a.tx));
        h.dot.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px)`;
        h.line.style.transform = `translate(${g.x.toFixed(1)}px, ${g.y.toFixed(1)}px) rotate(${Math.atan2(py - g.y, lx - g.x).toFixed(3)}rad)`;
        h.line.style.width = `${Math.hypot(lx - g.x, py - g.y).toFixed(1)}px`;
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
      } else if (h.root.style.display !== 'none' && now - h.hideT > HIDE_MS) h.root.style.display = 'none';
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
