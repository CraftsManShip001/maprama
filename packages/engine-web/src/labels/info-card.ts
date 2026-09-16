/**
 * Holographic info cards (`setInfoCard` / `removeInfoCard`): a structured place
 * card floating over a coordinate on a beam, in the same visual language as the
 * `holo` labels.
 *
 * ## Why DOM and not three.js
 *
 * The holo labels are already DOM, so a card drawn the same way matches them
 * pixel for pixel; the text is laid out and hinted by the browser instead of
 * resampled from a canvas texture; a screen reader can read it; and the layout
 * cost sits outside the render loop, which matters because the engine renders
 * **on demand**. The 3D feeling comes from the projected beam and a distance
 * scale, not from a mesh.
 *
 * ## Placement
 *
 * A card never loses: it is placed before the markers and the labels and its
 * box is handed to both passes as an exclusion, so they move out of its way
 * (`placeHolo` / `placeMarkers` already take `exclusions`). It is only
 * repositioned, never dropped:
 *
 * - it is hidden while its anchor is behind the camera;
 * - it is clamped horizontally and vertically into the **visible area**
 *   (`ui.contentInset`), so a bottom sheet never covers it;
 * - it shrinks with camera distance between {@link CARD_SCALE_MIN} and
 *   {@link CARD_SCALE_MAX}, never below a readable size.
 *
 * ## Frames
 *
 * {@link InfoCards.animating} is true only while a card is playing its
 * entrance or exit transition, so a card that is simply *there* holds no active
 * render source and the map goes fully idle (`scripts/idle-frames.mjs`).
 *
 * @module
 */

import {
  INFO_CARD_GROUND_HEIGHT_METERS,
  INFO_CARD_ROOF_HEIGHT_METERS,
  type InfoCardContent,
  type InfoCardSpec,
  type InfoRowIcon,
  type LabelIcon,
  type Projection,
} from '@maprama/protocol';
import type { CameraController } from '../core/camera.js';
import { inFront } from './dom-styles.js';
import { HOLO_ICONS, ICON_COLORS } from './icons.js';
import { clampLabelX, type Box } from './index.js';

/** Milliseconds the entrance transition runs (matches the card CSS). */
export const CARD_ENTER_MS = 340;
/** Milliseconds a removed card stays in the layout so its exit transition can play. */
export const CARD_EXIT_MS = 220;

/**
 * Camera distance (meters) at which a card is drawn at scale 1. Close to the
 * engine's default framing (36 world units × 8 m per unit ≈ 290 m), so a card
 * opened at the default camera is its natural size.
 */
export const CARD_REF_DISTANCE_METERS = 300;
/**
 * Smallest distance scale. The card's title is 13 px, so 0.78 keeps it at
 * ~10 px — still comfortably above the ~9 px floor where a Korean glyph stops
 * being legible on a phone.
 */
export const CARD_SCALE_MIN = 0.78;
/** Largest distance scale: a card right under the camera grows, but not into a poster. */
export const CARD_SCALE_MAX = 1.15;

/** Gap (CSS px) kept between a card and the edges of the visible area. */
const EDGE_MARGIN = 8;

/** `z-index` of the farthest card; nearer cards get higher values (see {@link InfoCards.update}). */
const CARD_BASE_Z_INDEX = 3;

/** Distance from the camera target to a card's anchor, in world units (`Infinity` without one). */
const cardDepth = (view: { anchor: InfoCardAnchorPoint | null }, cam: CameraController): number =>
  view.anchor ? Math.hypot(view.anchor.x - cam.orbit.x, view.anchor.z - cam.orbit.z) : Infinity;

/** A press reported by a card. */
export interface InfoCardPress {
  id: string;
  /** The pressed `content.actions` entry; absent for the card body. */
  actionId?: string;
}

/** Row icons, 16×16 line glyphs in the holo language (`currentColor` + `var(--c)` accent). */
const ROW_ICONS: Readonly<Record<InfoRowIcon, string>> = Object.freeze({
  hours:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/></svg>',
  location:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.2s4.4-4 4.4-7.4a4.4 4.4 0 0 0-8.8 0C3.6 10.2 8 14.2 8 14.2z"/><circle cx="8" cy="6.8" r="1.7"/></svg>',
  phone:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 3.4h2.4l1.1 2.7-1.4 1a7.6 7.6 0 0 0 3.6 3.6l1-1.4 2.7 1.1v2.4a1 1 0 0 1-1.1 1A10.4 10.4 0 0 1 2.2 4.5a1 1 0 0 1 1-1.1z"/></svg>',
  link:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 9.4a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.9.9"/><path d="M9.4 6.6a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.9-.9"/></svg>',
  info:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.6"/><circle cx="8" cy="5.1" r=".8" fill="currentColor" stroke="none"/></svg>',
  price:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6v10.8"/><path d="M10.7 5.1A2.6 2.6 0 0 0 8.4 4C6.9 4 5.7 4.9 5.7 6.2S7 8 8.2 8.2c1.4.3 2.6.7 2.6 2.1s-1.2 2.1-2.7 2.1a2.8 2.8 0 0 1-2.5-1.3"/></svg>',
});

/** Anchor of a card in world units, resolved against the loaded world. */
export interface InfoCardAnchorPoint {
  x: number;
  z: number;
  /** Y of the beam's foot (the ground, or the building's roof). */
  baseY: number;
  /** Height of the card above `baseY`, in world units. */
  height: number;
  /**
   * The building the card stands on, when it is roof-anchored. The lookup
   * (point in footprint) runs once per `setInfoCard`; `baseY` is refreshed from
   * this id every frame, because the zoom-out view squashes the buildings and
   * the beam has to keep its foot on the roof.
   */
  buildingId?: string;
}

interface CardView {
  spec: InfoCardSpec;
  root: HTMLDivElement;
  dot: HTMLElement;
  line: HTMLElement;
  panel: HTMLDivElement;
  card: HTMLElement;
  body: HTMLDivElement;
  actions: HTMLDivElement;
  close: HTMLButtonElement;
  anchor: InfoCardAnchorPoint | null;
  /** Content signature, so a card whose content did not change is not rebuilt. */
  key: string;
  w: number;
  h: number;
  on: boolean;
  /** `performance.now()` of the last visibility change (drives {@link InfoCards.animating}). */
  changedAt: number;
  removing: boolean;
}

const num = (v: number): string => v.toFixed(1);

/** The text a screen reader announces for a card, in content order. */
export function cardAccessibilityLabel(content: InfoCardContent): string {
  const parts: string[] = [content.title];
  if (content.subtitle) parts.push(content.subtitle);
  for (const b of content.badges ?? []) parts.push(b.text);
  if (content.rating) {
    parts.push(content.rating.count === undefined ? `${content.rating.value}` : `${content.rating.value} (${content.rating.count})`);
  }
  for (const r of content.rows ?? []) parts.push(r.text);
  return parts.join(', ');
}

/** Distance scale of a card at `distanceMeters` (square-root damped, clamped). */
export function cardScale(distanceMeters: number): number {
  if (!(distanceMeters > 0)) return CARD_SCALE_MAX;
  const raw = Math.sqrt(CARD_REF_DISTANCE_METERS / distanceMeters);
  return Math.min(CARD_SCALE_MAX, Math.max(CARD_SCALE_MIN, raw));
}

/** The info cards of one engine, drawn as DOM cards in the label layer. */
export class InfoCards {
  private readonly views = new Map<string, CardView>();
  /** Boxes of the cards shown in the last pass (handed to the marker and label passes). */
  private boxes: Box[] = [];
  /** Frame timestamp of the last {@link update}; {@link animating} is measured against it. */
  private lastNow = 0;

  /**
   * @param layerEl Returns the DOM layer to draw into (the label layer, created on demand).
   * @param onPress Receives presses (card body, action buttons).
   * @param onDismiss Receives close-button presses.
   * @param resolveAnchor Resolves a card's world anchor (roof lookup lives in the engine).
   * @param roofY Current roof height of a building, per frame (`null` when it is gone).
   */
  constructor(
    private readonly layerEl: () => HTMLElement,
    private readonly onPress: (press: InfoCardPress) => void,
    private readonly onDismiss: (id: string) => void,
    private readonly resolveAnchor: (spec: InfoCardSpec) => InfoCardAnchorPoint | null,
    private readonly roofY: (buildingId: string) => number | null,
  ) {}

  /** Card ids currently set. */
  ids(): string[] {
    return [...this.views.keys()];
  }

  /** The resolved world anchor of a card (for `focusOn { infoCardId }`). */
  anchorOf(id: string): InfoCardAnchorPoint | null {
    return this.views.get(id)?.anchor ?? null;
  }

  /** Creates or replaces one card. Content that did not change is not re-rendered. */
  setCard(spec: InfoCardSpec, now: number): void {
    const existing = this.views.get(spec.id);
    const view = existing ?? this.create(spec, now);
    view.spec = spec;
    view.anchor = this.resolveAnchor(spec);
    view.removing = false;
    const key = JSON.stringify(spec.content) + `|${spec.dismissible === true}|${spec.beam !== false}`;
    if (view.key !== key) {
      view.key = key;
      this.render(view);
      view.w = 0;
    }
    view.root.classList.toggle('mpr-ic-nobeam', spec.beam === false);
  }

  /**
   * Starts the exit transition of a card; it leaves the DOM in a later update,
   * once {@link CARD_EXIT_MS} has passed.
   */
  removeCard(id: string, now: number): void {
    const view = this.views.get(id);
    if (!view) return;
    if (!view.on) {
      view.root.remove();
      this.views.delete(id);
      return;
    }
    view.removing = true;
    view.on = false;
    view.changedAt = now;
    view.root.classList.remove('on');
  }

  /** Re-resolves every anchor after a world (and therefore projection) change. */
  reproject(): void {
    for (const view of this.views.values()) view.anchor = this.resolveAnchor(view.spec);
  }

  /**
   * Projects and positions every card. Returns the boxes of the visible ones,
   * which the marker and label passes take as exclusions.
   */
  /**
   * @param heightScale How much of the column a card floats over is drawn
   *   (1 = 2.5D, 0 = the flat 2D view, where the card sits on its coordinate).
   *   A roof anchor's `baseY` needs no scaling: it is re-read from the building,
   *   which the flat view has already brought down to the ground.
   */
  update(cam: CameraController, proj: Projection, now: number, heightScale = 1): Box[] {
    this.lastNow = now;
    if (this.views.size === 0) {
      if (this.boxes.length) this.boxes = [];
      return this.boxes;
    }
    const v = cam.view;
    const scale = cardScale(proj.unitsToMeters(cam.orbit.distance));
    const boxes: Box[] = [];
    // Cards do not hide each other — how many to show at once is the app's choice, not a
    // collision rule. Where two overlap, the one nearer the camera target is drawn on top, so
    // the overlap reads as depth instead of as a glitch.
    const order = [...this.views.values()].sort((a, b) => cardDepth(b, cam) - cardDepth(a, cam));
    for (let rank = 0; rank < order.length; rank++) {
      const view = order[rank]!;
      const z = CARD_BASE_Z_INDEX + rank;
      if (view.panel.style.zIndex !== `${z}`) view.panel.style.zIndex = `${z}`;
      if (view.removing && now - view.changedAt > CARD_EXIT_MS) {
        view.root.remove();
        this.views.delete(view.spec.id);
        continue;
      }
      if (view.removing) continue;
      const a = view.anchor;
      const visible = !!a && inFront(cam, a.x, a.z);
      if (!a || !visible) {
        this.show(view, false, now);
        continue;
      }
      // The zoom-out view squashes the buildings, so a roof anchor is re-read every frame.
      if (a.buildingId !== undefined) {
        const y = this.roofY(a.buildingId);
        if (y !== null) a.baseY = y;
      }
      const foot = cam.worldToScreen(a.x, a.baseY, a.z);
      const top = cam.worldToScreen(a.x, a.baseY + a.height * heightScale, a.z);
      if (!view.w) {
        view.root.style.display = '';
        view.w = view.card.offsetWidth;
        view.h = view.card.offsetHeight;
      }
      const hw = (view.w * scale) / 2, hh = (view.h * scale) / 2;
      // Keep the whole card inside the visible area: X like the holo labels, Y so the card body
      // (which sits above its anchor) never slides under the top inset or below the bottom one.
      const px = clampLabelX(top.x, hw, v.width, EDGE_MARGIN, v.x);
      const loY = v.y + EDGE_MARGIN + 2 * hh, hiY = v.y + v.height - EDGE_MARGIN;
      const py = loY > hiY ? v.y + v.height / 2 : Math.min(hiY, Math.max(loY, top.y));
      // the leader line ends under the (possibly shifted) panel, as in holo.ts
      const inset = Math.min(14, hw);
      const lx = Math.min(px + hw - inset, Math.max(px - hw + inset, top.x));
      view.dot.style.transform = `translate(${num(foot.x)}px, ${num(foot.y)}px)`;
      view.line.style.transform = `translate(${num(foot.x)}px, ${num(foot.y)}px) rotate(${Math.atan2(py - foot.y, lx - foot.x).toFixed(3)}rad)`;
      view.line.style.width = `${num(Math.hypot(lx - foot.x, py - foot.y))}px`;
      view.panel.style.transform = `translate(${num(px)}px, ${num(py)}px) translate(-50%, calc(-100% - 4px)) scale(${scale.toFixed(3)})`;
      this.show(view, true, now);
      boxes.push({ x: px, y: py - hh - 4, hw: hw + 6, hh: hh + 6 });
    }
    this.boxes = boxes;
    return boxes;
  }

  /**
   * True while a card is still playing its entrance or exit transition,
   * measured against the last {@link update} (which the engine runs immediately
   * before asking). A card that is simply on screen holds nothing, so the map
   * goes fully idle with cards up.
   */
  get animating(): boolean {
    const now = this.lastNow;
    for (const view of this.views.values()) {
      if (view.removing) return true;
      if (view.on && now - view.changedAt <= CARD_ENTER_MS) return true;
      if (!view.on && view.root.style.display !== 'none' && now - view.changedAt <= CARD_EXIT_MS) return true;
    }
    return false;
  }

  /** Removes every card immediately. */
  dispose(): void {
    for (const view of this.views.values()) view.root.remove();
    this.views.clear();
    this.boxes = [];
  }

  // ---------------------------------------------------------------------------

  private show(view: CardView, on: boolean, now: number): void {
    if (view.on === on) {
      if (!on && view.root.style.display !== 'none' && now - view.changedAt > CARD_EXIT_MS) view.root.style.display = 'none';
      return;
    }
    view.on = on;
    view.changedAt = now;
    if (on) {
      view.root.style.display = '';
      void view.root.offsetWidth;
      view.root.classList.add('on');
    } else view.root.classList.remove('on');
  }

  private create(spec: InfoCardSpec, now: number): CardView {
    const parent = this.layerEl();
    const doc = parent.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
      const e = doc.createElement(tag);
      e.className = cls;
      return e;
    };
    const root = el('div', 'mpr-ic');
    root.dataset.infoCardId = spec.id;
    root.style.display = 'none';
    const line = el('i', 'mpr-ic-line'), dot = el('i', 'mpr-ic-dot');
    const panel = el('div', 'mpr-ic-panel');
    // One accessibility element for the whole card (`role="group"` + a composed label read in
    // content order), with the informational block hidden from the tree so it is not announced
    // twice; the action buttons below stay real, individually focusable buttons.
    const card = el('section', 'mpr-ic-card');
    card.setAttribute('role', 'group');
    const body = el('div', 'mpr-ic-body');
    body.setAttribute('aria-hidden', 'true');
    const actions = el('div', 'mpr-ic-actions');
    const close = el('button', 'mpr-ic-close');
    close.type = 'button';
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>';
    close.hidden = true;
    card.append(close, body, actions);
    panel.append(card);
    root.append(line, dot, panel);
    parent.appendChild(root);

    const view: CardView = {
      spec, root, dot, line, panel, card, body, actions, close,
      anchor: null, key: '', w: 0, h: 0, on: false, changedAt: now, removing: false,
    };
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onDismiss(view.spec.id);
    });
    // The card body is pressable too: `infoCard:press` without an `actionId`.
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const button = target?.closest?.('.mpr-ic-act') as HTMLElement | null;
      const actionId = button?.dataset.actionId;
      this.onPress(actionId ? { id: view.spec.id, actionId } : { id: view.spec.id });
    });
    this.views.set(spec.id, view);
    return view;
  }

  /** Rebuilds a card's DOM from its content (only when the content signature changed). */
  private render(view: CardView): void {
    const doc = view.root.ownerDocument;
    const c = view.spec.content;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    view.card.setAttribute('aria-label', cardAccessibilityLabel(c));
    // The close button floats over the top-right corner, so a dismissible card reserves that
    // space in the heading — a title long enough to wrap used to run underneath it.
    view.card.classList.toggle('mpr-ic-closable', view.spec.dismissible === true);
    view.close.hidden = view.spec.dismissible !== true;
    view.close.setAttribute('aria-label', `${c.title} 닫기`);

    view.body.textContent = '';
    const head = el('div', 'mpr-ic-head');
    if (c.icon) {
      const ico = el('span', 'mpr-ic-ico');
      ico.style.setProperty('--c', ICON_COLORS[c.icon as LabelIcon]);
      ico.innerHTML = HOLO_ICONS[c.icon as LabelIcon];
      head.append(ico);
    }
    const heading = el('div', 'mpr-ic-heading');
    const title = el('b');
    title.textContent = c.title;
    heading.append(title);
    if (c.subtitle) {
      const sub = el('small');
      sub.textContent = c.subtitle;
      heading.append(sub);
    }
    head.append(heading);
    view.body.append(head);

    const meta = el('div', 'mpr-ic-meta');
    if (c.rating) {
      const rating = el('span', 'mpr-ic-rating');
      const star = el('i');
      star.textContent = '★';
      const value = el('b');
      // One decimal, the convention for a place rating — and it keeps a host value that came out
      // of arithmetic (4.399999999999999) from being printed in full.
      value.textContent = c.rating.value.toFixed(1);
      rating.append(star, value);
      if (c.rating.count !== undefined) {
        const count = el('small');
        count.textContent = `(${c.rating.count.toLocaleString('en-US')})`;
        rating.append(count);
      }
      meta.append(rating);
    }
    for (const b of c.badges ?? []) {
      const badge = el('span', `mpr-ic-badge tone-${b.tone ?? 'neutral'}`);
      badge.textContent = b.text;
      meta.append(badge);
    }
    if (meta.childElementCount) view.body.append(meta);

    if (c.rows?.length) {
      const list = el('ul', 'mpr-ic-rows');
      for (const r of c.rows) {
        const li = el('li');
        const icon = el('i');
        if (r.icon) icon.innerHTML = ROW_ICONS[r.icon];
        const text = el('span');
        text.textContent = r.text;
        li.append(icon, text);
        list.append(li);
      }
      view.body.append(list);
    }

    view.actions.textContent = '';
    for (const a of c.actions ?? []) {
      const button = el('button', `mpr-ic-act${a.primary ? ' primary' : ''}`);
      button.type = 'button';
      button.dataset.actionId = a.id;
      button.textContent = a.label;
      view.actions.append(button);
    }
    view.actions.hidden = !c.actions?.length;
  }
}

/** Default card height above its anchor, in meters, for an anchor kind. */
export function defaultCardHeightMeters(onRoof: boolean): number {
  return onRoof ? INFO_CARD_ROOF_HEIGHT_METERS : INFO_CARD_GROUND_HEIGHT_METERS;
}
