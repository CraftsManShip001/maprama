import { decodeTile, type MtilTile } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { encodeTile } from '../../../protocol/src/__fixtures__/tile.js';
import { assembleTileWorld } from '../tiles/assemble.js';
import { TileFrame, tileOf } from '../tiles/mercator.js';
import { MaterialFactory } from '../theme/materials.js';
import { renderParamsFor } from '../theme/params.js';
import type { TextureSet } from '../theme/textures.js';
import type { WorldModel } from '../world/model.js';
import { BuildingRenderer, sameShape } from './buildings.js';
import type { RenderContext } from './parts.js';

const SEOUL = { lng: 127.056, lat: 37.5445 };
const EXTENT = 8192;
const at = tileOf(SEOUL.lng, SEOUL.lat, 15);

/**
 * `ids` as 24 m squares on a grid. Position and height come from the **id**,
 * not from the position in the list, so a building is the same building
 * whichever other tiles happen to be in the world — which is what the tile
 * archive guarantees and what these tests are about.
 */
const tileWith = (ids: readonly string[]): MtilTile =>
  decodeTile(
    encodeTile({
      extent: EXTENT,
      buffer: 256,
      layers: {
        buildings: ids.map((id) => {
          const k = id.charCodeAt(0) % 16;
          const x = 500 + (k % 4) * 700, y = 500 + Math.floor(k / 4) * 700;
          return { id, heightDm: 100 + k * 30, footprint: [[x, y], [x + 300, y], [x + 300, y + 300], [x, y + 300]] as [number, number][] };
        }),
      },
    }),
  );

/** A world of the given building ids, anchored at `anchor` (a different anchor is a re-base). */
function world(ids: readonly string[], anchor = SEOUL, dx = 0): WorldModel {
  return assembleTileWorld([{ z: 15, x: at.x + dx, y: at.y, tile: tileWith(ids) }], {
    frame: new TileFrame(anchor, SEOUL.lat, 8),
    attribution: [],
    name: 'x',
  });
}

/**
 * A render context with real render params and materials. The textures are only
 * ever read for material options and facade UV steps, and three takes
 * `undefined` for a map, so a stub with the facade table filled in is enough to
 * build the whole scene graph without a canvas.
 */
function context(w: WorldModel): RenderContext {
  const facade = new Proxy({}, { get: () => ({ tex: undefined, lit: undefined, U: 1, V: 1 }) }) as TextureSet['facade'];
  return { params: renderParamsFor({ base: 'urban', timeOfDay: 'day' }), mats: new MaterialFactory(), tex: { facade } as TextureSet, world: w };
}

/**
 * Every mesh of every building, by building id, **by reference** — reuse means
 * the very same objects come back, not equal-looking ones.
 */
function meshes(r: BuildingRenderer): Map<string, object[]> {
  const out = new Map<string, object[]>();
  for (const g of r.group.children) {
    const id = g.userData.buildingId as string;
    const list: object[] = [];
    g.traverse((o) => { if (o !== g) list.push(o); });
    out.set(id, list);
  }
  return out;
}

/** Asserts the two lists are the same objects in the same order. */
function sameObjects(a: object[] | undefined, b: object[] | undefined): void {
  expect(a).toBeDefined();
  expect(a).toHaveLength(b?.length ?? -1);
  for (let i = 0; i < (a?.length ?? 0); i++) expect(a![i]).toBe(b![i]);
}

describe('sameShape', () => {
  const a = world(['a', 'b']).buildings;

  it('is true for the same tile assembled around a different anchor', () => {
    const b = world(['a', 'b'], { lng: SEOUL.lng + 0.04, lat: SEOUL.lat - 0.03 }).buildings;
    expect(a).toHaveLength(2);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.x).not.toBe(b[i]!.x);
      expect(sameShape(a[i]!, b[i]!)).toBe(true);
    }
  });

  it('is false when the building itself differs', () => {
    const taller = { ...a[0]!, h: a[0]!.h + 1 };
    expect(sameShape(a[0]!, taller)).toBe(false);
    const reshaped = { ...a[0]!, footprint: a[0]!.footprint.map(([x, z]) => [x * 1.5, z] as [number, number]) };
    expect(sameShape(a[0]!, reshaped)).toBe(false);
    expect(sameShape(a[0]!, a[1]!)).toBe(false);
  });
});

describe('BuildingRenderer incremental rebuilds', () => {
  it('keeps the meshes of a building that only moved, and moves its group', () => {
    const r = new BuildingRenderer();
    const w0 = world(['a', 'b', 'c']);
    const ctx0 = context(w0);
    r.build(ctx0);
    const before = meshes(r);

    // A re-base: the same tile, a different anchor.
    const w1 = world(['a', 'b', 'c'], { lng: SEOUL.lng + 0.05, lat: SEOUL.lat });
    r.build({ ...ctx0, world: w1 }, true);
    const after = meshes(r);

    expect([...after.keys()].sort()).toEqual(['a', 'b', 'c']);
    for (const id of after.keys()) sameObjects(after.get(id), before.get(id));
    const moved = r.group.children.find((g) => g.userData.buildingId === 'a')!;
    expect(moved.position.x).toBeCloseTo(w1.buildings.find((b) => b.id === 'a')!.x, 9);
  });

  it('builds only what arrived and drops only what left', () => {
    const r = new BuildingRenderer();
    const ctx = context(world(['a', 'b', 'c']));
    r.build(ctx);
    const before = meshes(r);

    r.build({ ...ctx, world: world(['b', 'c', 'd']) }, true);
    const after = meshes(r);

    expect([...after.keys()].sort()).toEqual(['b', 'c', 'd']);
    sameObjects(after.get('b'), before.get('b'));
    sameObjects(after.get('c'), before.get('c'));
    expect(after.get('d')![0]).not.toBe(before.get('a')![0]);
    expect(r.has('a')).toBe(false);
  });

  it('produces the same scene graph as a rebuild from nothing', () => {
    const shape = (r: BuildingRenderer): string[] =>
      [...r.group.children]
        .map((g) => `${g.userData.buildingId as string}@${g.position.x.toFixed(6)},${g.position.z.toFixed(6)}:${countMeshes(g)}`)
        .sort();

    const incremental = new BuildingRenderer();
    const ctx = context(world(['a', 'b', 'c']));
    incremental.build(ctx);
    const next = world(['b', 'c', 'd']);
    incremental.build({ ...ctx, world: next }, true);

    const fresh = new BuildingRenderer();
    fresh.build({ ...ctx, world: next });

    expect(shape(incremental)).toEqual(shape(fresh));
  });

  it('refuses to reuse across a theme change', () => {
    const r = new BuildingRenderer();
    const w = world(['a', 'b']);
    r.build(context(w));
    const before = meshes(r);
    // A new params/materials generation: everything must be built again.
    r.build(context(w), true);
    expect(meshes(r).get('a')![0]).not.toBe(before.get('a')![0]);
  });
});

function countMeshes(o: { traverse(cb: (child: unknown) => void): void }): number {
  let n = 0;
  o.traverse(() => { n++; });
  return n;
}
