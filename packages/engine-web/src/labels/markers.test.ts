import { DEFAULT_SNAP_TO_BUILDING_METERS, type MarkerSpec, type Projection, type SetMarkerLayerCommand } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import type { CameraController } from '../core/camera.js';
import type { AnchorContext } from './anchor.js';
import type { Box } from './index.js';
import {
  DEFAULT_MARKER_COLOR,
  MarkerLayers,
  baseShape,
  compareMarkers,
  markerKey,
  markerSnapMeters,
  placeMarkers,
  resolveMarkerPoint,
  type MarkerCandidate,
  type MarkerPress,
} from './markers.js';

// ---------------------------------------------------------------------------
// A minimal DOM, in the style of `engine/engine.test.ts`'s `fakeDom` but with a
// real node tree, attributes and class list, so the assertions below inspect
// what the engine actually renders. `vitest`'s environment is `node` and the
// repo ships no jsdom.
// ---------------------------------------------------------------------------

interface FakeElement {
  tagName: string;
  className: string;
  id: string;
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  alt: string;
  src: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  props: Map<string, string>;
  classes: Set<string>;
  dataset: Record<string, string | undefined>;
  style: Record<string, string> & { setProperty(name: string, value: string): void };
  ownerDocument: FakeDocument;
  listeners: Map<string, (() => void)[]>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  classList: { toggle(name: string, on: boolean): void; contains(name: string): boolean };
  /** Test helper: dispatches a click the way keyboard / screen-reader activation does. */
  click(): void;
}

interface FakeDocument {
  head: FakeElement;
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
}

function fakeDocument(): FakeDocument {
  const byId = new Map<string, FakeElement>();
  const doc: FakeDocument = {
    head: undefined as unknown as FakeElement,
    createElement(tag: string): FakeElement {
      const el: FakeElement = {
        tagName: tag.toUpperCase(),
        className: '',
        id: '',
        hidden: false,
        innerHTML: '',
        textContent: '',
        alt: '',
        src: '',
        children: [],
        parent: null,
        attrs: new Map(),
        props: new Map(),
        classes: new Set(),
        dataset: {},
        ownerDocument: doc,
        listeners: new Map(),
        style: Object.assign(Object.create(null) as Record<string, string>, {
          setProperty(name: string, value: string) {
            el.props.set(name, value);
          },
        }),
        setAttribute(name, value) {
          el.attrs.set(name, value);
          if (name === 'id') {
            el.id = value;
            byId.set(value, el);
          }
        },
        removeAttribute(name) {
          el.attrs.delete(name);
        },
        getAttribute(name) {
          return el.attrs.get(name) ?? null;
        },
        appendChild(child) {
          child.parent = el;
          el.children.push(child);
          if (child.id) byId.set(child.id, child);
          return child;
        },
        remove() {
          const siblings = el.parent?.children;
          if (siblings) siblings.splice(siblings.indexOf(el), 1);
          el.parent = null;
        },
        addEventListener(type, fn) {
          const list = el.listeners.get(type) ?? [];
          list.push(fn);
          el.listeners.set(type, list);
        },
        classList: {
          toggle(name, on) {
            if (on) el.classes.add(name);
            else el.classes.delete(name);
          },
          contains: (name) => el.classes.has(name),
        },
        click() {
          for (const fn of el.listeners.get('click') ?? []) fn();
        },
      };
      // `style.id = x` on a <style> element is used by ensureMarkerStyles.
      return new Proxy(el, {
        set(target, key, value) {
          if (key === 'id') {
            target.id = String(value);
            byId.set(String(value), target);
            return true;
          }
          (target as unknown as Record<string, unknown>)[key as string] = value;
          return true;
        },
      });
    },
    getElementById: (id) => byId.get(id) ?? null,
  };
  doc.head = doc.createElement('head');
  return doc;
}

/** A camera that projects world x/z straight to screen pixels. */
function fakeCamera(width = 390, height = 760, inset = { top: 0, right: 0, bottom: 0, left: 0 }): CameraController {
  return {
    width,
    height,
    inset,
    view: { x: inset.left, y: inset.top, width: width - inset.left - inset.right, height: height - inset.top - inset.bottom },
    orbit: { x: 0, z: 0, distance: 40, pitch: 50, bearing: 0 },
    worldToScreen: (x: number, _y: number, z: number) => ({ x, y: z, visible: true }),
    // `inFront` reads `camera.position` and `camera.matrixWorld` (columns 3 = the camera's
    // local +Z in world space). A camera 100 units up looking straight down has +Z = world +Y,
    // so every ground point is in front of it.
    camera: { position: { x: 0, y: 100, z: 0 }, matrixWorld: { elements: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1] } },
  } as unknown as CameraController;
}

const proj = { toWorld: (ll: { lng: number; lat: number }) => ({ x: ll.lng, z: ll.lat }) } as unknown as Projection;

const at = (x: number, z: number) => ({ lng: x, lat: z });

function layers(onPress: (press: MarkerPress) => void = () => {}): { markers: MarkerLayers; root: FakeElement; doc: FakeDocument } {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  return { markers: new MarkerLayers(() => root as unknown as HTMLElement, onPress), root, doc };
}

const cards = (root: FakeElement): FakeElement[] => root.children.filter((c) => c.className === 'mpr-mk');

const candidate = (over: Partial<MarkerCandidate> & { key: string }): MarkerCandidate => ({
  layerId: 'poi',
  markerId: over.key,
  priority: 0,
  forced: false,
  onScreen: true,
  dT: 0,
  box: { x: 100, y: 100, hw: 14, hh: 18 },
  ...over,
});

// ---------------------------------------------------------------------------

describe('marker placement order', () => {
  it('places forced markers first, then priority desc, then nearest, then key', () => {
    const list = [
      candidate({ key: 'b', priority: 5, dT: 10 }),
      candidate({ key: 'a', priority: 5, dT: 10 }),
      candidate({ key: 'c', priority: 9, dT: 99 }),
      candidate({ key: 'd', priority: 5, dT: 2 }),
      candidate({ key: 'e', priority: -1, forced: true }),
    ];
    expect([...list].sort(compareMarkers).map((c) => c.key)).toEqual(['e', 'c', 'd', 'a', 'b']);
  });

  it('drops a colliding lower-priority marker and keeps the higher one', () => {
    const box: Box = { x: 100, y: 100, hw: 14, hh: 18 };
    const shown = placeMarkers(
      [candidate({ key: 'low', priority: 0, box }), candidate({ key: 'high', priority: 10, box: { ...box, x: 104 } })],
      [],
    );
    expect(shown.map((s) => s.key)).toEqual(['high']);
  });

  it('never drops alwaysVisible or selected markers, even over a HUD zone or another marker', () => {
    const hud: Box = { x: 195, y: 20, hw: 195, hh: 30 };
    const box: Box = { x: 195, y: 20, hw: 14, hh: 18 };
    const shown = placeMarkers(
      [
        candidate({ key: 'plain', box }),
        candidate({ key: 'always', forced: true, box }),
        candidate({ key: 'selected', forced: true, box: { ...box, x: 200 } }),
      ],
      [hud],
    );
    expect(shown.map((s) => s.key)).toEqual(['always', 'selected']);
  });

  it('skips off-screen markers', () => {
    expect(placeMarkers([candidate({ key: 'off', onScreen: false, forced: true })], [])).toEqual([]);
  });
});

describe('MarkerLayers partial updates', () => {
  const base: SetMarkerLayerCommand = {
    type: 'setMarkerLayer',
    layerId: 'poi',
    markers: [
      { id: 'a', coordinate: at(60, 100), color: '#112233', accessibilityLabel: 'Alpha, Blue' },
      { id: 'b', coordinate: at(160, 100), color: '#112233', icon: { uri: 'data:image/svg+xml,<svg/>' }, accessibilityLabel: 'Bravo, Blue' },
      { id: 'c', coordinate: at(260, 100), color: '#112233', icon: 'dot', accessibilityLabel: 'Charlie, Blue' },
    ],
    selectedId: 'a',
  };

  it('changing only colour and selection reloads no icon and creates no view', () => {
    const { markers, root } = layers();
    markers.setLayer(base, proj);
    expect(markers.stats).toEqual({ viewsCreated: 3, iconLoads: 1 });
    expect(cards(root)).toHaveLength(3);

    const recolored: SetMarkerLayerCommand = {
      ...base,
      markers: base.markers.map((m) => ({ ...m, color: '#FF8800' })),
      selectedId: 'c',
    };
    markers.setLayer(recolored, proj);

    // The whole point of the design: no new views, no icon reload.
    expect(markers.stats).toEqual({ viewsCreated: 3, iconLoads: 1 });
    expect(cards(root)).toHaveLength(3);
    for (const card of cards(root)) expect(card.props.get('--mk')).toBe('#FF8800');
    const selected = cards(root).filter((c) => c.classes.has('mpr-mk-on'));
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute('aria-label')).toBe('Charlie, Blue');
    expect(selected[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('reloads the icon only when the icon changes, and recycles views instead of destroying them', () => {
    const { markers, root } = layers();
    markers.setLayer(base, proj);
    markers.setLayer({ ...base, markers: base.markers.map((m) => (m.id === 'b' ? { ...m, icon: { uri: 'https://cdn.example/pin.svg' } } : m)) }, proj);
    expect(markers.stats.iconLoads).toBe(2);
    expect(markers.stats.viewsCreated).toBe(3);

    // Dropping a marker recycles its card; adding one again reuses it.
    markers.setLayer({ ...base, markers: base.markers.slice(0, 2) }, proj);
    expect(cards(root)).toHaveLength(3); // pooled, still in the DOM
    markers.setLayer(base, proj);
    expect(markers.stats.viewsCreated).toBe(3);
    expect(cards(root)).toHaveLength(3);
  });

  it('defaults the colour and applies the size and anchor of the layer', () => {
    const { markers, root } = layers();
    markers.setLayer({ type: 'setMarkerLayer', layerId: 'poi', markers: [{ id: 'a', coordinate: at(10, 10) }], size: 48, anchor: 'center' }, proj);
    const card = cards(root)[0]!;
    expect(card.props.get('--mk')).toBe(DEFAULT_MARKER_COLOR);
    expect(card.props.get('--mk-h')).toBe('48px');
    expect(card.props.get('--mk-w')).toBe('36px'); // pin aspect 24/32
    expect(card.style.transformOrigin).toBe('50% 50%');
  });
});

describe('marker accessibility (rendered DOM)', () => {
  it('renders a labelled button per marker and hides unlabelled ones from assistive technology', () => {
    const { markers, root } = layers();
    markers.setLayer(
      {
        type: 'setMarkerLayer',
        layerId: 'poi',
        markers: [
          { id: 'a', coordinate: at(60, 100), accessibilityLabel: 'Gyeongbokgung, Blue' },
          { id: 'b', coordinate: at(160, 100) },
        ],
        selectedId: 'a',
      },
      proj,
    );
    const [a, b] = cards(root) as [FakeElement, FakeElement];
    expect(a.tagName).toBe('BUTTON');
    expect(a.getAttribute('type')).toBe('button');
    expect(a.getAttribute('aria-label')).toBe('Gyeongbokgung, Blue');
    expect(a.getAttribute('aria-current')).toBe('true');
    expect(a.getAttribute('aria-hidden')).toBeNull();
    expect(a.getAttribute('tabindex')).toBeNull();
    // The base shape is decorative markup inside the labelled button.
    expect(a.children[0]!.className).toBe('mpr-mk-shape');
    expect(a.children[0]!.innerHTML).toContain('aria-hidden="true"');

    expect(b.getAttribute('aria-label')).toBeNull();
    expect(b.getAttribute('aria-current')).toBeNull();
    expect(b.getAttribute('aria-hidden')).toBe('true');
    expect(b.getAttribute('tabindex')).toBe('-1');
  });

  it('activating a card (keyboard / screen reader) reports the press with the marker anchor', () => {
    const presses: MarkerPress[] = [];
    const { markers, root } = layers((p) => presses.push(p));
    markers.setLayer(
      { type: 'setMarkerLayer', layerId: 'poi', markers: [{ id: 'a', coordinate: at(60, 100), accessibilityLabel: 'Alpha' }] },
      proj,
    );
    markers.update(fakeCamera(), [], 0);
    cards(root)[0]!.click();
    expect(presses).toEqual([{ layerId: 'poi', markerId: 'a', coordinate: { lng: 60, lat: 100 }, point: { x: 60, y: 100 } }]);
  });
});

describe('MarkerLayers.update and hit testing', () => {
  const cmd: SetMarkerLayerCommand = {
    type: 'setMarkerLayer',
    layerId: 'poi',
    markers: [
      { id: 'a', coordinate: at(60, 100), accessibilityLabel: 'A' },
      { id: 'b', coordinate: at(60, 104), accessibilityLabel: 'B' }, // overlaps a
      { id: 'far', coordinate: at(300, 400), accessibilityLabel: 'Far' },
    ],
    selectedId: 'a',
  };

  it('hides collided markers, reserves boxes for the labels and hit-tests in placement order', () => {
    const { markers, root } = layers();
    markers.setLayer(cmd, proj);
    const boxes = markers.update(fakeCamera(), [], 0);
    // `a` is selected (forced) and wins; `b` collides with it and is hidden; `far` is placed.
    expect(boxes).toHaveLength(2);
    const hidden = cards(root).filter((c) => c.hidden);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.getAttribute('aria-label')).toBe('B');

    // `anchor: 'bottom'` puts the card above the coordinate, so the box sits above the pin tip.
    const hit = markers.hitTest(60, 100 - 18);
    expect(hit).toEqual({ layerId: 'poi', markerId: 'a', coordinate: { lng: 60, lat: 100 }, point: { x: 60, y: 100 } });
    expect(markers.hitTest(5, 700)).toBeNull();
  });

  it('a HUD exclusion hides a plain marker but never the selected one', () => {
    const { markers } = layers();
    markers.setLayer({ ...cmd, selectedId: 'far' }, proj);
    const hud: Box = { x: 195, y: 100, hw: 195, hh: 40 };
    const boxes = markers.update(fakeCamera(), [hud], 0);
    expect(boxes).toHaveLength(1);
    expect(markers.hitTest(300, 400 - 22)?.markerId).toBe('far');
  });

  it('forgets a removed layer', () => {
    const { markers } = layers();
    markers.setLayer(cmd, proj);
    markers.update(fakeCamera(), [], 0);
    markers.removeLayer('poi');
    expect(markers.layerIds()).toEqual([]);
    expect(markers.update(fakeCamera(), [], 0)).toEqual([]);
    expect(markers.hitTest(60, 82)).toBeNull();
  });
});

describe('helpers', () => {
  it('maps icons to a base shape and builds stable keys', () => {
    expect(baseShape(undefined)).toBe('pin');
    expect(baseShape('pin')).toBe('pin');
    expect(baseShape('dot')).toBe('dot');
    expect(baseShape({ uri: 'x' })).toBe('pin');
    expect(markerKey('poi', 'a')).not.toBe(markerKey('poi', 'b'));
    expect(markerKey('a', 'b')).not.toBe(markerKey('a b', ''));
  });
});

// ---------------------------------------------------------------------------
// Anchor height and building snapping (brief T). `fakeCamera.worldToScreen`
// maps (x, y, z) to (x, z), so the screen position alone cannot show the
// height — the assertions read the resolved `MarkerPoint` instead, and one
// end-to-end case checks that a roof anchor changes what `update` draws.
// ---------------------------------------------------------------------------

const metricProj = {
  toWorld: (ll: { lng: number; lat: number }) => ({ x: ll.lng, z: ll.lat }),
  metersToUnits: (m: number) => m / 8,
  unitsToMeters: (u: number) => u * 8,
} as unknown as Projection;

/** One 10×10-unit building at the origin, 12 units tall. */
const anchorCtx: AnchorContext = {
  buildings: [{ id: 'b1', footprint: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
  roofY: (id) => (id === 'b1' ? 12 : null),
  groundY: 0,
};

const spec = (over: Partial<MarkerSpec> & { coordinate: MarkerSpec['coordinate'] }): MarkerSpec => ({ id: 'm', ...over });

describe('marker anchor height and snapping', () => {
  it('defaults to the ground: no building lookup, no move', () => {
    const p = resolveMarkerPoint(spec({ coordinate: at(5, 5) }), metricProj, anchorCtx);
    expect(p).toEqual({ x: 5, z: 5, lift: 0 });
  });

  it('anchorHeight "roof" attaches the containing building without snapping', () => {
    const p = resolveMarkerPoint(spec({ coordinate: at(5, 5), anchorHeight: 'roof' }), metricProj, anchorCtx);
    expect(p).toMatchObject({ x: 5, z: 5, buildingId: 'b1', lift: 0 });
    // Outside every footprint and not opted into snapping: stays where it is.
    expect(resolveMarkerPoint(spec({ coordinate: at(-3, 5), anchorHeight: 'roof' }), metricProj, anchorCtx))
      .toEqual({ x: -3, z: 5, lift: 0 });
  });

  it('a numeric anchorHeight lifts the marker in meters, without a building', () => {
    const p = resolveMarkerPoint(spec({ coordinate: at(5, 5), anchorHeight: 24 }), metricProj, anchorCtx);
    expect(p).toEqual({ x: 5, z: 5, lift: 3 }); // 24 m at 8 m/unit
  });

  it('snapToBuilding moves the coordinate onto the nearest footprint and reports the distance', () => {
    const p = resolveMarkerPoint(spec({ coordinate: at(-2, 5), snapToBuilding: true }), metricProj, anchorCtx);
    expect(p.snapDistanceMeters).toBeCloseTo(16); // 2 units at 8 m/unit
    expect(p.x).toBeGreaterThan(0);
    // Ground anchor: snapping alone does not attach the building for drawing.
    expect(p.buildingId).toBeUndefined();
  });

  it('honours an explicit radius and gives up beyond it', () => {
    const near = resolveMarkerPoint(spec({ coordinate: at(-2, 5), snapToBuilding: { maxDistanceMeters: 20 } }), metricProj, anchorCtx);
    expect(near.snapDistanceMeters).toBeCloseTo(16);
    const far = resolveMarkerPoint(spec({ coordinate: at(-2, 5), snapToBuilding: { maxDistanceMeters: 10 } }), metricProj, anchorCtx);
    expect(far).toEqual({ x: -2, z: 5, lift: 0 });
  });

  it('markerSnapMeters reads the three shapes of the option', () => {
    expect(markerSnapMeters(spec({ coordinate: at(0, 0) }))).toBe(0);
    expect(markerSnapMeters(spec({ coordinate: at(0, 0), snapToBuilding: false }))).toBe(0);
    expect(markerSnapMeters(spec({ coordinate: at(0, 0), snapToBuilding: true }))).toBe(DEFAULT_SNAP_TO_BUILDING_METERS);
    expect(markerSnapMeters(spec({ coordinate: at(0, 0), snapToBuilding: {} }))).toBe(DEFAULT_SNAP_TO_BUILDING_METERS);
    expect(markerSnapMeters(spec({ coordinate: at(0, 0), snapToBuilding: { maxDistanceMeters: 5 } }))).toBe(5);
  });

  it('without a world (no anchor context) every marker stays on its own coordinate', () => {
    expect(resolveMarkerPoint(spec({ coordinate: at(-2, 5), snapToBuilding: true, anchorHeight: 'roof' }), metricProj, null))
      .toEqual({ x: -2, z: 5, lift: 0 });
  });

  it('a roof-anchored marker follows the roof, and falls back to the ground when the building is gone', () => {
    const { markers } = layers();
    markers.setLayer(
      { type: 'setMarkerLayer', layerId: 'poi', markers: [{ id: 'a', coordinate: at(5, 5), anchorHeight: 'roof' }] },
      metricProj,
      anchorCtx,
    );
    // `worldToScreen` here is (x, y, z) -> (x, z), so record what Y it was given.
    const seen: number[] = [];
    const cam = fakeCamera();
    const spy = { ...cam, worldToScreen: (x: number, y: number, z: number) => { seen.push(y); return { x, y: z, visible: true }; } } as unknown as CameraController;
    markers.update(spy, [], 0, (id) => (id === 'b1' ? 12 : null));
    expect(seen).toEqual([12]);
    seen.length = 0;
    markers.update(spy, [], 0, () => null); // building no longer drawn
    expect(seen).toEqual([0]);
  });

  it('marker:press keeps reporting the original coordinate after a snap', () => {
    const presses: MarkerPress[] = [];
    const { markers, root } = layers((p) => presses.push(p));
    markers.setLayer(
      { type: 'setMarkerLayer', layerId: 'poi', markers: [{ id: 'a', coordinate: at(-2, 5), snapToBuilding: true }] },
      metricProj,
      anchorCtx,
    );
    markers.update(fakeCamera(), [], 0);
    cards(root)[0]!.click();
    expect(presses[0]!.coordinate).toEqual({ lng: -2, lat: 5 });
  });
});
