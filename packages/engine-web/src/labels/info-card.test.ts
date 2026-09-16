import type { InfoCardSpec, Projection } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import type { CameraController } from '../core/camera.js';
import {
  CARD_ENTER_MS,
  CARD_EXIT_MS,
  CARD_REF_DISTANCE_METERS,
  CARD_SCALE_MAX,
  CARD_SCALE_MIN,
  InfoCards,
  cardAccessibilityLabel,
  cardScale,
  defaultCardHeightMeters,
  type InfoCardAnchorPoint,
  type InfoCardPress,
} from './info-card.js';

// ---------------------------------------------------------------------------
// A minimal DOM with a real node tree, as in `markers.test.ts` (vitest runs in
// `node` here and the repo ships no jsdom). It implements exactly what
// `info-card.ts` touches: append / textContent clearing, dataset, classList,
// attributes, `offsetWidth` / `offsetHeight` and click dispatch with
// `target.closest`.
// ---------------------------------------------------------------------------

interface El {
  tagName: string;
  className: string;
  type: string;
  hidden: boolean;
  innerHTML: string;
  children: El[];
  parent: El | null;
  attrs: Map<string, string>;
  props: Map<string, string>;
  classes: Set<string>;
  dataset: Record<string, string | undefined>;
  style: Record<string, string> & { setProperty(n: string, v: string): void };
  ownerDocument: Doc;
  listeners: Map<string, ((e: FakeEvent) => void)[]>;
  offsetWidth: number;
  offsetHeight: number;
  textContent: string;
  childElementCount: number;
  setAttribute(n: string, v: string): void;
  getAttribute(n: string): string | null;
  appendChild(c: El): El;
  append(...c: El[]): void;
  remove(): void;
  addEventListener(t: string, fn: (e: FakeEvent) => void): void;
  classList: { add(n: string): void; remove(n: string): void; toggle(n: string, on: boolean): void; contains(n: string): boolean };
  closest(selector: string): El | null;
  /** Test helper: dispatches a click that bubbles to the card, as a real one does. */
  click(): void;
}

interface FakeEvent {
  target: El;
  stopPropagation(): void;
}

interface Doc {
  createElement(tag: string): El;
}

function fakeDocument(): Doc {
  const doc: Doc = {
    createElement(tag: string): El {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        type: '',
        hidden: false,
        innerHTML: '',
        children: [] as El[],
        parent: null as El | null,
        attrs: new Map<string, string>(),
        props: new Map<string, string>(),
        classes: new Set<string>(),
        dataset: {} as Record<string, string | undefined>,
        ownerDocument: doc,
        listeners: new Map<string, ((e: FakeEvent) => void)[]>(),
        offsetWidth: 220,
        offsetHeight: 140,
        style: Object.assign(Object.create(null) as Record<string, string>, {
          setProperty(n: string, v: string) {
            el.props.set(n, v);
          },
        }),
        get textContent(): string {
          return el.children.map((c) => c.textContent).join('') || (el.attrs.get('__text') ?? '');
        },
        set textContent(value: string) {
          el.children.length = 0;
          el.attrs.set('__text', value);
        },
        get childElementCount(): number {
          return el.children.length;
        },
        setAttribute(n: string, v: string) {
          el.attrs.set(n, v);
        },
        getAttribute: (n: string) => el.attrs.get(n) ?? null,
        appendChild(c: El) {
          c.parent = el;
          el.children.push(c);
          return c;
        },
        append(...cs: El[]) {
          for (const c of cs) el.appendChild(c);
        },
        remove() {
          const siblings = el.parent?.children;
          if (siblings) siblings.splice(siblings.indexOf(el), 1);
          el.parent = null;
        },
        addEventListener(t: string, fn: (e: FakeEvent) => void) {
          const list = el.listeners.get(t) ?? [];
          list.push(fn);
          el.listeners.set(t, list);
        },
        classList: {
          add: (n: string) => void el.classes.add(n),
          remove: (n: string) => void el.classes.delete(n),
          toggle(n: string, on: boolean) {
            if (on) el.classes.add(n);
            else el.classes.delete(n);
          },
          contains: (n: string) => el.classes.has(n),
        },
        closest(selector: string): El | null {
          const want = selector.replace('.', '');
          let node: El | null = el;
          while (node) {
            if (node.classes.has(want) || node.className.split(' ').includes(want)) return node;
            node = node.parent;
          }
          return null;
        },
        click() {
          // A click bubbles: run the listeners from this node up to the root, in order,
          // unless one of them stops propagation (the close button does).
          let stopped = false;
          const event: FakeEvent = { target: el, stopPropagation: () => { stopped = true; } };
          let node: El | null = el;
          while (node && !stopped) {
            for (const fn of node.listeners.get('click') ?? []) {
              fn(event);
              if (stopped) break;
            }
            node = node.parent;
          }
        },
      } as unknown as El;
      // `className` is set right after createElement, and `classList` has to see it.
      return new Proxy(el, {
        set(target, key, value) {
          if (key === 'className') {
            for (const c of String(target.className).split(' ')) if (c) target.classes.delete(c);
            for (const c of String(value).split(' ')) if (c) target.classes.add(c);
          }
          (target as unknown as Record<string, unknown>)[key as string] = value;
          return true;
        },
      });
    },
  };
  return doc;
}

/** A camera projecting world (x, z) straight to screen pixels, with y lifting the point up. */
function fakeCamera(inset = { top: 0, right: 0, bottom: 0, left: 0 }, width = 390, height = 760): CameraController {
  return {
    width,
    height,
    inset,
    view: { x: inset.left, y: inset.top, width: width - inset.left - inset.right, height: height - inset.top - inset.bottom },
    orbit: { x: 0, z: 0, distance: 40, pitch: 50, bearing: 0 },
    worldToScreen: (x: number, y: number, z: number) => ({ x, y: z - y, visible: true }),
    camera: { position: { x: 0, y: 1000, z: 0 }, matrixWorld: { elements: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1] } },
  } as unknown as CameraController;
}

const proj = { unitsToMeters: (u: number) => u * 8 } as unknown as Projection;

const SPEC: InfoCardSpec = {
  id: 'poi-1',
  coordinate: { lng: 100, lat: 300 },
  content: {
    title: '스타벅스 판교점',
    subtitle: '카페',
    icon: 'cafe',
    badges: [{ text: '영업 중', tone: 'good' }],
    rating: { value: 4.3, count: 1281 },
    rows: [
      { icon: 'hours', text: '22:00 영업 종료' },
      { icon: 'phone', text: '031-000-0000' },
    ],
    actions: [
      { id: 'route', label: '길찾기', primary: true },
      { id: 'call', label: '전화' },
    ],
  },
};

interface Harness {
  cards: InfoCards;
  root: El;
  presses: InfoCardPress[];
  dismissed: string[];
}

function harness(anchor: InfoCardAnchorPoint | null = { x: 100, z: 300, baseY: 0, height: 4 }, roofY: (id: string) => number | null = () => null): Harness {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  const presses: InfoCardPress[] = [];
  const dismissed: string[] = [];
  const cards = new InfoCards(
    () => root as unknown as HTMLElement,
    (p) => presses.push(p),
    (id) => dismissed.push(id),
    () => (anchor ? { ...anchor } : null),
    roofY,
  );
  return { cards, root, presses, dismissed };
}

const cardEls = (root: El): El[] => root.children.filter((c) => c.classes.has('mpr-ic'));
const find = (el: El, cls: string): El | null => {
  if (el.classes.has(cls)) return el;
  for (const c of el.children) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return null;
};
const findAll = (el: El, cls: string): El[] => {
  const out: El[] = [];
  const walk = (n: El): void => {
    if (n.classes.has(cls)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(el);
  return out;
};

// ---------------------------------------------------------------------------

describe('distance scale', () => {
  it('is 1 at the reference distance and clamped at both ends', () => {
    expect(cardScale(CARD_REF_DISTANCE_METERS)).toBeCloseTo(1, 6);
    expect(cardScale(30)).toBe(CARD_SCALE_MAX);
    expect(cardScale(100000)).toBe(CARD_SCALE_MIN);
    // Never below a readable size, and monotonically shrinking in between.
    expect(cardScale(400)).toBeGreaterThan(CARD_SCALE_MIN);
    expect(cardScale(400)).toBeLessThan(1);
    expect(cardScale(150)).toBeGreaterThan(1);
  });
});

describe('default heights', () => {
  it('lifts a ground card higher than a roof card', () => {
    expect(defaultCardHeightMeters(false)).toBeGreaterThan(defaultCardHeightMeters(true));
  });
});

describe('accessibility label', () => {
  it('reads title, subtitle, badges, rating and rows in content order', () => {
    expect(cardAccessibilityLabel(SPEC.content)).toBe(
      '스타벅스 판교점, 카페, 영업 중, 4.3 (1281), 22:00 영업 종료, 031-000-0000',
    );
  });

  it('skips the parts a card does not have', () => {
    expect(cardAccessibilityLabel({ title: 'Only' })).toBe('Only');
    expect(cardAccessibilityLabel({ title: 'A', rating: { value: 5 } })).toBe('A, 5');
  });
});

describe('rendering', () => {
  it('builds one accessibility element with real action buttons inside', () => {
    const h = harness();
    h.cards.setCard({ ...SPEC, dismissible: true }, 0);
    const [root] = cardEls(h.root);
    expect(root).toBeDefined();
    const card = find(root!, 'mpr-ic-card')!;
    expect(card.tagName).toBe('SECTION');
    expect(card.getAttribute('role')).toBe('group');
    expect(card.getAttribute('aria-label')).toBe(cardAccessibilityLabel(SPEC.content));
    // The informational block is hidden from the tree so it is not announced twice.
    expect(find(card, 'mpr-ic-body')!.getAttribute('aria-hidden')).toBe('true');
    const actions = findAll(card, 'mpr-ic-act');
    expect(actions.map((a) => a.dataset.actionId)).toEqual(['route', 'call']);
    expect(actions[0]!.classes.has('primary')).toBe(true);
    expect(actions.every((a) => a.tagName === 'BUTTON')).toBe(true);
    const close = find(card, 'mpr-ic-close')!;
    expect(close.hidden).toBe(false);
    expect(close.getAttribute('aria-label')).toContain(SPEC.content.title);
  });

  it('hides the close button unless the card is dismissible', () => {
    const h = harness();
    h.cards.setCard(SPEC, 0);
    expect(find(cardEls(h.root)[0]!, 'mpr-ic-close')!.hidden).toBe(true);
  });

  it('does not rebuild a card whose content did not change', () => {
    const h = harness();
    h.cards.setCard(SPEC, 0);
    const card = find(cardEls(h.root)[0]!, 'mpr-ic-card')!;
    const before = findAll(card, 'mpr-ic-act')[0]!;
    h.cards.setCard({ ...SPEC, coordinate: { lng: 101, lat: 301 } }, 0);
    expect(findAll(card, 'mpr-ic-act')[0]).toBe(before);
    // ...but a content change does rebuild it.
    h.cards.setCard({ ...SPEC, content: { ...SPEC.content, title: 'Other' } }, 0);
    expect(findAll(card, 'mpr-ic-act')[0]).not.toBe(before);
    expect(card.getAttribute('aria-label')).toContain('Other');
  });

  it('keeps one view per id and drops the beam when `beam: false`', () => {
    const h = harness();
    h.cards.setCard(SPEC, 0);
    h.cards.setCard({ ...SPEC, beam: false }, 0);
    expect(cardEls(h.root)).toHaveLength(1);
    expect(cardEls(h.root)[0]!.classes.has('mpr-ic-nobeam')).toBe(true);
    expect(h.cards.ids()).toEqual(['poi-1']);
  });
});

describe('presses', () => {
  it('reports the action id for a button and none for the card body', () => {
    const h = harness();
    h.cards.setCard({ ...SPEC, dismissible: true }, 0);
    const card = find(cardEls(h.root)[0]!, 'mpr-ic-card')!;
    findAll(card, 'mpr-ic-act')[1]!.click();
    find(card, 'mpr-ic-body')!.click();
    expect(h.presses).toEqual([{ id: 'poi-1', actionId: 'call' }, { id: 'poi-1' }]);
  });

  it('reports a dismiss without a press when the close button is used', () => {
    const h = harness();
    h.cards.setCard({ ...SPEC, dismissible: true }, 0);
    find(cardEls(h.root)[0]!, 'mpr-ic-close')!.click();
    expect(h.dismissed).toEqual(['poi-1']);
    expect(h.presses).toEqual([]);
  });
});

describe('placement', () => {
  it('positions the card above its anchor and reports an exclusion box', () => {
    const h = harness({ x: 180, z: 400, baseY: 0, height: 40 });
    h.cards.setCard(SPEC, 0);
    const boxes = h.cards.update(fakeCamera(), proj, 0);
    expect(boxes).toHaveLength(1);
    // The fake camera projects (x, z − y), so the card anchor is 40 px above the foot.
    expect(boxes[0]!.x).toBeCloseTo(180, 5);
    expect(boxes[0]!.y).toBeLessThan(360);
    const root = cardEls(h.root)[0]!;
    expect(root.classes.has('on')).toBe(true);
    expect(find(root, 'mpr-ic-panel')!.style.transform).toContain('translate(180.0px, 360.0px)');
  });

  it('clamps the card into the visible area, so a content inset never covers it', () => {
    const inset = { top: 0, right: 0, bottom: 420, left: 0 };
    const h = harness({ x: 4, z: 700, baseY: 0, height: 0 });
    h.cards.setCard(SPEC, 0);
    const boxes = h.cards.update(fakeCamera(inset), proj, 0);
    const box = boxes[0]!;
    // 220 × 140 card: its box has to sit inside [0, 390] × [0, 340] with a margin.
    expect(box.x - box.hw).toBeGreaterThanOrEqual(0);
    expect(box.x + box.hw).toBeLessThanOrEqual(390);
    expect(box.y - box.hh).toBeGreaterThanOrEqual(0);
    expect(box.y + box.hh).toBeLessThanOrEqual(340);
  });

  it('hides a card whose anchor cannot be resolved', () => {
    const h = harness(null);
    h.cards.setCard(SPEC, 0);
    expect(h.cards.update(fakeCamera(), proj, 0)).toEqual([]);
    expect(cardEls(h.root)[0]!.classes.has('on')).toBe(false);
  });

  it('re-reads a roof anchor every frame, so the zoom-out squash keeps the beam on the roof', () => {
    let roof = 30;
    const h = harness({ x: 100, z: 300, baseY: 30, height: 4, buildingId: 'b1' }, () => roof);
    h.cards.setCard(SPEC, 0);
    h.cards.update(fakeCamera(), proj, 0);
    const dot = find(cardEls(h.root)[0]!, 'mpr-ic-dot')!;
    expect(dot.style.transform).toContain('270.0px');
    roof = 10;
    h.cards.update(fakeCamera(), proj, 0);
    expect(dot.style.transform).toContain('290.0px');
  });
});

describe('render sources', () => {
  it('holds a source only while a card animates in, then lets the map go idle', () => {
    const h = harness();
    h.cards.setCard(SPEC, 1000);
    h.cards.update(fakeCamera(), proj, 1000);
    expect(h.cards.animating).toBe(true);
    // One frame after the entrance transition ended, nothing holds the loop awake any more.
    h.cards.update(fakeCamera(), proj, 1000 + CARD_ENTER_MS + 1);
    expect(h.cards.animating).toBe(false);
  });

  it('keeps a removed card in the layout for its exit transition, then removes it', () => {
    const h = harness();
    h.cards.setCard(SPEC, 0);
    h.cards.update(fakeCamera(), proj, 0);
    h.cards.removeCard('poi-1', 0);
    expect(cardEls(h.root)).toHaveLength(1);
    expect(h.cards.animating).toBe(true);
    h.cards.update(fakeCamera(), proj, CARD_EXIT_MS + 1);
    expect(cardEls(h.root)).toHaveLength(0);
    expect(h.cards.ids()).toEqual([]);
    expect(h.cards.animating).toBe(false);
  });

  it('removes a never-shown card immediately', () => {
    const h = harness();
    h.cards.setCard(SPEC, 0);
    h.cards.removeCard('poi-1', 0);
    expect(cardEls(h.root)).toHaveLength(0);
  });
});

describe('anchors', () => {
  it('exposes the resolved anchor for focusOn', () => {
    const h = harness({ x: 12, z: 34, baseY: 5, height: 3, buildingId: 'b7' });
    h.cards.setCard(SPEC, 0);
    expect(h.cards.anchorOf('poi-1')).toEqual({ x: 12, z: 34, baseY: 5, height: 3, buildingId: 'b7' });
    expect(h.cards.anchorOf('missing')).toBeNull();
  });
});
