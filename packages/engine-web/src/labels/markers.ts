/**
 * App-owned map markers (pins) drawn by the engine.
 *
 * Markers reuse the **label view pool**: every marker is a recycled DOM card
 * in the same layer as the DOM / holo labels, so they get accessibility
 * nodes, arbitrary SVG icons, cheap partial updates and one collision pass
 * shared with the labels — instead of a second GPU renderer.
 *
 * ## Placement order (one pass per frame, before the labels)
 *
 * 1. The HUD exclusion zones (status bar, map UI, bottom margin) are reserved
 *    first.
 * 2. **Forced** markers — `alwaysVisible`, plus the layer's `selectedId` — come
 *    next, in priority order, and are *never* dropped: they ignore both the HUD
 *    zones and earlier boxes, and reserve their own box.
 * 3. The remaining markers follow, sorted by `priority` (higher first), then by
 *    distance to the camera target (nearer first), then by key for a stable
 *    order. One is shown when its box overlaps neither a HUD zone nor an
 *    already-placed box.
 * 4. The boxes of the shown markers go to the label pass as extra exclusions,
 *    so a label never covers a marker and a marker never yields to a label.
 *
 * ## Partial updates
 *
 * {@link MarkerLayers.setLayer} diffs the incoming specs against the views by
 * id and touches only what changed: a different `color` writes one CSS custom
 * property and a different `selectedId` toggles one class plus the transform's
 * scale. Neither reloads an icon nor recreates a view — see
 * {@link MarkerLayers.stats}, which the tests assert on.
 *
 * @module
 */

import type { LngLat, MarkerAnchor, MarkerIcon, MarkerShape, MarkerSpec, Projection, SetMarkerLayerCommand } from '@maprama/protocol';
import type { CameraController } from '../core/camera.js';
import { inFront } from './dom-styles.js';
import { overlaps, type Box } from './index.js';

/** Marker height in dp when the layer sets no `size`. */
export const DEFAULT_MARKER_SIZE = 36;
/** Scale of the selected marker when the layer sets no `selectedScale`. */
export const DEFAULT_SELECTED_SCALE = 1.25;
/** Tint of the base shape when a marker sets no `color`. */
export const DEFAULT_MARKER_COLOR = '#2F5BEA';
/** Which point of the marker sits on the coordinate when the layer sets no `anchor`. */
export const DEFAULT_MARKER_ANCHOR: MarkerAnchor = 'bottom';

/** Separator of the `layerId` / `markerId` pair in a view key (`\u0000`, as in the drop visuals: ids never contain it). */
const SEP = '\u0000';

const STYLE_ID = 'maprama-engine-markers-style';

const CSS = `
.mpr-mk{position:absolute;left:0;top:0;z-index:2;display:block;margin:0;padding:0;border:0;background:none;font:inherit;color:var(--mk,${DEFAULT_MARKER_COLOR});pointer-events:none;will-change:transform;-webkit-tap-highlight-color:transparent}
.mpr-mk[hidden]{display:none}
.mpr-mk-shape{position:relative;display:block;height:var(--mk-h,${DEFAULT_MARKER_SIZE}px);width:var(--mk-w,${DEFAULT_MARKER_SIZE}px)}
.mpr-mk-shape>svg{display:block;width:100%;height:100%;filter:drop-shadow(0 2px 3px rgba(20,30,60,.28))}
.mpr-mk-img{position:absolute;left:50%;top:14%;width:46%;height:46%;transform:translateX(-50%);object-fit:contain}
.mpr-mk-on>.mpr-mk-shape>svg{filter:drop-shadow(0 6px 12px rgba(20,30,60,.5))}
.mpr-mk:focus-visible{outline:2px solid #2F5BEA;outline-offset:2px}
`;

/** Injects the marker stylesheet once per document. */
export function ensureMarkerStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** Built-in base shapes, tinted with the marker's `color` through `currentColor`. */
const SHAPES: Readonly<Record<MarkerShape, { svg: string; aspect: number }>> = Object.freeze({
  pin: {
    aspect: 24 / 32,
    svg: '<svg viewBox="0 0 24 32" aria-hidden="true" focusable="false"><path d="M12 31C12 31 22.4 19.4 22.4 11.6A10.4 10.4 0 0 0 1.6 11.6C1.6 19.4 12 31 12 31Z" fill="currentColor" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="11.4" r="4.1" fill="#fff" fill-opacity=".93"/></svg>',
  },
  dot: {
    aspect: 1,
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="currentColor" stroke="#fff" stroke-width="2.4"/></svg>',
  },
});

/** Anchor → the translate applied after the screen position, its transform origin, and where the box center sits relative to the anchor. */
const ANCHORS: Readonly<Record<MarkerAnchor, { shift: string; origin: string; centerFactor: number }>> = Object.freeze({
  bottom: { shift: 'translate(-50%, -100%)', origin: '50% 100%', centerFactor: -0.5 },
  center: { shift: 'translate(-50%, -50%)', origin: '50% 50%', centerFactor: 0 },
  top: { shift: 'translate(-50%, 0)', origin: '50% 0', centerFactor: 0.5 },
});

/** Base shape of an icon; a custom image is drawn inside the pin. */
export const baseShape = (icon: MarkerIcon | undefined): MarkerShape => (icon === 'dot' ? 'dot' : 'pin');

/** Stable view key of a marker across layers. */
export const markerKey = (layerId: string, markerId: string): string => `${layerId}${SEP}${markerId}`;

/** A marker projected for one frame. */
export interface MarkerCandidate {
  key: string;
  layerId: string;
  markerId: string;
  priority: number;
  /** `alwaysVisible`, or the layer's selected marker: never dropped by collision. */
  forced: boolean;
  onScreen: boolean;
  /** Distance to the camera target in world units (tie-break). */
  dT: number;
  box: Box;
}

/** Placement order: forced first, then priority desc, then nearest to the camera target, then key. */
export function compareMarkers(a: MarkerCandidate, b: MarkerCandidate): number {
  if (a.forced !== b.forced) return a.forced ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.dT !== b.dT) return a.dT - b.dT;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Greedy placement in the documented order. Returns the shown markers with
 * their boxes **in placement order** (highest priority first), which is also
 * the hit-test order.
 */
export function placeMarkers(candidates: readonly MarkerCandidate[], exclusions: readonly Box[]): { key: string; box: Box }[] {
  const placed: Box[] = [...exclusions];
  const shown: { key: string; box: Box }[] = [];
  for (const c of [...candidates].sort(compareMarkers)) {
    if (!c.onScreen) continue;
    if (!c.forced && placed.some((p) => overlaps(p, c.box))) continue;
    placed.push(c.box);
    shown.push({ key: c.key, box: c.box });
  }
  return shown;
}

/** One layer's resolved state. */
interface LayerState {
  layerId: string;
  markers: MarkerSpec[];
  selectedId: string | null;
  selectedScale: number;
  size: number;
  anchor: MarkerAnchor;
  /** Anchor in world units per marker id. */
  points: Map<string, { x: number; z: number }>;
}

interface MarkerView {
  el: HTMLElement;
  shape: HTMLElement;
  img: HTMLImageElement | null;
  /** Descriptor of the icon currently applied (never re-applied while equal). */
  iconKey: string;
  colorKey: string;
  /** `null` until the first sync, so an empty label still runs its branch once. */
  labelKey: string | null;
  sizeKey: string;
  anchorKey: string;
  selected: boolean;
  shown: boolean;
}

/** A press on a marker: what `marker:press` reports. */
export interface MarkerPress {
  layerId: string;
  markerId: string;
  coordinate: LngLat;
  /** The marker's anchor on screen in CSS pixels (the pin tip for `anchor: 'bottom'`). */
  point: { x: number; y: number };
}

const iconKeyOf = (icon: MarkerIcon | undefined): string =>
  icon === undefined ? 'pin' : typeof icon === 'string' ? icon : `uri:${icon.uri}`;

/** The marker layers of one engine, drawn as recycled DOM cards in the label layer. */
export class MarkerLayers {
  /** @internal Test hooks: how often a view was created and an icon image loaded. */
  readonly stats = { viewsCreated: 0, iconLoads: 0 };

  private readonly layers = new Map<string, LayerState>();
  private readonly views = new Map<string, MarkerView>();
  private readonly pool: MarkerView[] = [];
  /** Shown markers of the last frame, in placement (= hit-test) order. */
  private hits: { key: string; box: Box; x: number; y: number }[] = [];

  /**
   * @param layerEl Returns the DOM layer to draw into (the label layer, created on demand).
   * @param onPress Receives keyboard / assistive-technology activations of a marker card.
   */
  constructor(private readonly layerEl: () => HTMLElement, private readonly onPress: (press: MarkerPress) => void) {}

  /** Layer ids currently set. */
  layerIds(): string[] {
    return [...this.layers.keys()];
  }

  /**
   * Creates or replaces a layer. Markers that stay are updated field by field:
   * only a new id creates a view, only a changed icon loads an image.
   */
  setLayer(cmd: SetMarkerLayerCommand, proj: Projection | null): void {
    const previous = this.layers.get(cmd.layerId);
    const state: LayerState = {
      layerId: cmd.layerId,
      markers: cmd.markers.map((m) => ({ ...m, coordinate: { ...m.coordinate } })),
      selectedId: cmd.selectedId ?? null,
      selectedScale: cmd.selectedScale ?? DEFAULT_SELECTED_SCALE,
      size: cmd.size ?? DEFAULT_MARKER_SIZE,
      anchor: cmd.anchor ?? DEFAULT_MARKER_ANCHOR,
      points: new Map(),
    };
    this.layers.set(cmd.layerId, state);
    if (proj) this.project(state, proj);
    else if (previous) for (const m of state.markers) {
      const p = previous.points.get(m.id);
      if (p) state.points.set(m.id, p);
    }
    this.sync(state, previous);
  }

  /** Removes a layer and recycles its views. */
  removeLayer(layerId: string): void {
    const state = this.layers.get(layerId);
    if (!state) return;
    this.layers.delete(layerId);
    for (const m of state.markers) this.recycle(markerKey(layerId, m.id));
    this.hits = this.hits.filter((h) => !h.key.startsWith(`${layerId}${SEP}`));
  }

  /** Re-projects every layer after a world (and therefore projection) change. */
  reproject(proj: Projection): void {
    for (const state of this.layers.values()) this.project(state, proj);
  }

  /**
   * Projects and places every marker, then applies the result to the DOM.
   * Returns the boxes of the shown markers, which the label pass takes as
   * extra exclusions.
   */
  update(cam: CameraController, exclusions: readonly Box[], groundY: number): Box[] {
    if (this.layers.size === 0) {
      if (this.hits.length) this.hits = [];
      return [];
    }
    const candidates: MarkerCandidate[] = [];
    const screen = new Map<string, { x: number; y: number }>();
    const o = cam.orbit, v = cam.view;
    for (const state of this.layers.values()) {
      for (const m of state.markers) {
        const p = state.points.get(m.id);
        if (!p) continue;
        const key = markerKey(state.layerId, m.id);
        const s = cam.worldToScreen(p.x, groundY, p.z);
        const selected = state.selectedId === m.id;
        const height = state.size * (selected ? state.selectedScale : 1);
        const width = height * SHAPES[baseShape(m.icon)].aspect;
        screen.set(key, { x: s.x, y: s.y });
        candidates.push({
          key,
          layerId: state.layerId,
          markerId: m.id,
          priority: m.priority ?? 0,
          forced: m.alwaysVisible === true || selected,
          onScreen:
            s.x >= v.x - width && s.x <= v.x + v.width + width && s.y >= v.y - height &&
            s.y <= v.y + v.height + height && inFront(cam, p.x, p.z),
          dT: Math.hypot(p.x - o.x, p.z - o.z),
          box: { x: s.x, y: s.y + height * ANCHORS[state.anchor].centerFactor, hw: width / 2 + 2, hh: height / 2 + 2 },
        });
      }
    }
    const shown = placeMarkers(candidates, exclusions);
    const visible = new Set(shown.map((s) => s.key));
    for (const c of candidates) {
      const view = this.views.get(c.key);
      if (!view) continue;
      const on = visible.has(c.key);
      if (view.shown !== on) {
        view.shown = on;
        view.el.hidden = !on;
      }
      if (!on) continue;
      const state = this.layers.get(c.layerId);
      const at = screen.get(c.key);
      if (!state || !at) continue;
      const scale = state.selectedId === c.markerId ? state.selectedScale : 1;
      const shift = ANCHORS[state.anchor].shift;
      view.el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) ${shift}${scale === 1 ? '' : ` scale(${scale})`}`;
    }
    this.hits = shown.map((s) => ({ ...s, ...(screen.get(s.key) ?? { x: s.box.x, y: s.box.y }) }));
    return shown.map((s) => s.box);
  }

  /**
   * The marker under a CSS pixel point, or `null`. Placement order decides, so
   * the higher-priority marker wins where two boxes overlap (only possible
   * between forced markers).
   */
  hitTest(x: number, y: number): MarkerPress | null {
    for (const h of this.hits) {
      if (Math.abs(x - h.box.x) > h.box.hw || Math.abs(y - h.box.y) > h.box.hh) continue;
      const press = this.pressFor(h.key);
      if (press) return { ...press, point: { x: h.x, y: h.y } };
    }
    return null;
  }

  /** Removes every view and forgets the layers. */
  dispose(): void {
    for (const key of [...this.views.keys()]) this.recycle(key);
    for (const v of this.pool.splice(0)) v.el.remove();
    this.layers.clear();
    this.hits = [];
  }

  // ---------------------------------------------------------------------------

  private project(state: LayerState, proj: Projection): void {
    state.points.clear();
    for (const m of state.markers) state.points.set(m.id, proj.toWorld(m.coordinate));
  }

  private pressFor(key: string): Omit<MarkerPress, 'point'> | null {
    const i = key.indexOf(SEP);
    const layerId = key.slice(0, i);
    const markerId = key.slice(i + 1);
    const spec = this.layers.get(layerId)?.markers.find((m) => m.id === markerId);
    return spec ? { layerId, markerId, coordinate: { ...spec.coordinate } } : null;
  }

  /** Creates, updates or recycles the views of one layer: the partial-update pass. */
  private sync(state: LayerState, previous: LayerState | undefined): void {
    const ids = new Set(state.markers.map((m) => m.id));
    if (previous) for (const m of previous.markers) if (!ids.has(m.id)) this.recycle(markerKey(state.layerId, m.id));
    for (const m of state.markers) {
      const key = markerKey(state.layerId, m.id);
      const view = this.views.get(key) ?? this.acquire(key);
      const colorKey = m.color ?? DEFAULT_MARKER_COLOR;
      if (view.colorKey !== colorKey) {
        view.colorKey = colorKey;
        view.el.style.setProperty('--mk', colorKey);
      }
      const shape = baseShape(m.icon);
      const sizeKey = `${state.size}|${shape}`;
      if (view.sizeKey !== sizeKey) {
        view.sizeKey = sizeKey;
        view.el.style.setProperty('--mk-h', `${state.size}px`);
        view.el.style.setProperty('--mk-w', `${state.size * SHAPES[shape].aspect}px`);
      }
      if (view.anchorKey !== state.anchor) {
        view.anchorKey = state.anchor;
        view.el.style.transformOrigin = ANCHORS[state.anchor].origin;
      }
      const iconKey = `${shape}|${iconKeyOf(m.icon)}`;
      if (view.iconKey !== iconKey) this.applyIcon(view, shape, m.icon, iconKey);
      const labelKey = m.accessibilityLabel ?? '';
      if (view.labelKey !== labelKey) {
        view.labelKey = labelKey;
        if (labelKey) {
          view.el.setAttribute('aria-label', labelKey);
          view.el.removeAttribute('aria-hidden');
          view.el.removeAttribute('tabindex');
        } else {
          // A marker without a label is decorative: keep it out of the
          // accessibility tree and out of the tab order.
          view.el.removeAttribute('aria-label');
          view.el.setAttribute('aria-hidden', 'true');
          view.el.setAttribute('tabindex', '-1');
        }
      }
      const selected = state.selectedId === m.id;
      if (view.selected !== selected) {
        view.selected = selected;
        view.el.classList.toggle('mpr-mk-on', selected);
        // `aria-current` (not `aria-pressed`): the marker is the selected item of
        // its layer, not a toggle button.
        if (selected) view.el.setAttribute('aria-current', 'true');
        else view.el.removeAttribute('aria-current');
      }
    }
  }

  private applyIcon(view: MarkerView, shape: MarkerShape, icon: MarkerIcon | undefined, iconKey: string): void {
    const before = view.iconKey.split('|')[0];
    view.iconKey = iconKey;
    if (before !== shape) view.shape.innerHTML = SHAPES[shape].svg;
    const uri = icon && typeof icon !== 'string' ? icon.uri : null;
    if (!uri) {
      view.img?.remove();
      view.img = null;
      return;
    }
    if (!view.img) {
      const img = view.el.ownerDocument.createElement('img');
      img.className = 'mpr-mk-img';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      view.shape.appendChild(img);
      view.img = img;
    }
    this.stats.iconLoads++;
    view.img.src = uri;
  }

  private acquire(key: string): MarkerView {
    const view = this.pool.pop() ?? this.create();
    view.el.dataset.markerKey = key;
    view.shown = false;
    view.el.hidden = true;
    this.views.set(key, view);
    return view;
  }

  private create(): MarkerView {
    const parent = this.layerEl();
    const doc = parent.ownerDocument;
    ensureMarkerStyles(doc);
    const el = doc.createElement('button');
    el.setAttribute('type', 'button');
    el.className = 'mpr-mk';
    el.hidden = true;
    const shape = doc.createElement('span');
    shape.className = 'mpr-mk-shape';
    shape.innerHTML = SHAPES.pin.svg;
    el.appendChild(shape);
    parent.appendChild(el);
    // Keyboard (Enter / Space) and assistive-technology activation dispatch a
    // click straight at the element, so this works although the card is
    // `pointer-events: none`. Pointer taps are hit-tested by the engine's
    // `tap` instead, which keeps panning possible from anywhere on the map.
    el.addEventListener('click', () => {
      const viewKey = el.dataset.markerKey;
      const press = viewKey ? this.pressFor(viewKey) : null;
      if (!press) return;
      const hit = this.hits.find((h) => h.key === viewKey);
      this.onPress({ ...press, point: hit ? { x: hit.x, y: hit.y } : { x: 0, y: 0 } });
    });
    this.stats.viewsCreated++;
    return { el, shape, img: null, iconKey: 'pin|pin', colorKey: '', labelKey: null, sizeKey: '', anchorKey: '', selected: false, shown: false };
  }

  private recycle(key: string): void {
    const view = this.views.get(key);
    if (!view) return;
    this.views.delete(key);
    view.el.hidden = true;
    view.shown = false;
    delete view.el.dataset.markerKey;
    this.pool.push(view);
  }
}
