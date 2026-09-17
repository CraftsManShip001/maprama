/**
 * Flat building renderer — what a building *is* in the 2D view.
 *
 * Dropping the extrusion height to zero is not enough to make a map: a squashed
 * prism still carries its facade textures, its roof furniture, its parapet and
 * its contact-shadow decal, all coplanar at ground level and z-fighting with
 * each other. A 2D map draws a building as what a map draws: a **filled
 * footprint with an outline**.
 *
 * That is also where the mode's performance comes from. The 2.5D renderer draws
 * one `Group` per building (walls, storefront band, roof, parapet, trims,
 * rails, decorations…), so a 2,457-building world is thousands of draw calls
 * with a shadow pass over all of them. This renderer merges every footprint
 * into **one fill mesh per distinct colour plus one outline mesh** — typically
 * seven draw calls for the whole town — with unlit `MeshBasicMaterial`s that
 * neither cast, receive nor read a shadow map and are excluded from the fog.
 *
 * During a transition both renderers are up: the extruded buildings shrink
 * while the fill fades in ({@link FlatBuildings.apply}), and the extruded group
 * is hidden outright once the fade is over.
 *
 * @module
 */

import { Group, Mesh, type BufferGeometry, type MeshBasicMaterial } from 'three';
import type { Vec2 } from '@maprama/protocol';
import type { MaterialFactory } from '../theme/materials.js';
import type { RenderParams } from '../theme/params.js';
import type { WorldModel } from '../world/model.js';
import { cssHexToNumber, mixHex } from '../util/math.js';
import { capGeometry } from './footprint.js';
import { mergeFlat, ribbonGeo } from './geometry.js';
import { clearGroup, noRaycast } from './parts.js';
import type { BuildingOverride } from './buildings.js';

/** Outline stroke width in world units (≈1 m at the default 8 m per unit). */
export const FLAT_OUTLINE_WIDTH = 0.12;
/** Fill height above the ground, in world units: clear of the roads and pads, below anything 3D. */
const FILL_Y = 0.16;
/** The outline sits a hair above its own fill so the two never z-fight. */
const OUTLINE_Y = FILL_Y + 0.004;
/** Flatness below which the flat layer is not drawn at all (it would be invisible anyway). */
const FADE_IN_AT = 0.35;

/** Fill and outline colour of one building in the flat view. */
export interface FlatColors {
  fill: number;
  outline: number;
}

/** Neutral the fill is pulled towards: a light warm grey that separates from every ground treatment. */
const FILL_NEUTRAL = 0xc6ccd4;
/** Map ink the outline is pulled towards. */
const OUTLINE_INK = 0x333a44;

/**
 * Flat colours for a building colour, keeping the theme's character while
 * guaranteeing the contrast a map needs.
 *
 * Both are **mixes towards a fixed neutral**, not lightness offsets, because
 * several presets are already near-white (`urban`'s stone and white-graphite
 * schemes, `minimal`): lightening those gives a fill indistinguishable from the
 * ground and an outline that barely reads, whatever the offset. Pulling 38 %
 * towards a light grey and 75 % towards map ink keeps `toy` pastel and `urban`
 * stone-coloured while every footprint still has an edge.
 */
export function flatColorsFor(color: number): FlatColors {
  return { fill: mixHex(color, FILL_NEUTRAL, 0.38), outline: mixHex(color, OUTLINE_INK, 0.75) };
}

/** Resolves the 2.5D colour of a building, honouring a `setBuildingStyle` override. */
export function buildingColor(params: RenderParams, ci: number, override: BuildingOverride | undefined): number {
  if (override?.color !== undefined) return override.color;
  return cssHexToNumber(params.palette[ci % params.palette.length]!);
}

export class FlatBuildings {
  readonly group = new Group();
  /** Set when the world, the theme or a building style changed and the geometry has to be rebuilt. */
  private dirty = true;
  private fills: { mesh: Mesh; mat: MeshBasicMaterial }[] = [];
  private outline: { mesh: Mesh; mat: MeshBasicMaterial } | null = null;
  private applied = -1;

  constructor() {
    this.group.name = 'flat-buildings';
    this.group.visible = false;
  }

  /**
   * Drops the built geometry; it is rebuilt on the next {@link update} that
   * needs it. The meshes go away immediately rather than on the rebuild,
   * because a theme change disposes the material generation they were created
   * in — keeping them up for one more frame would draw with a disposed
   * material.
   */
  invalidate(): void {
    this.dispose();
  }

  /**
   * Per-frame entry point. `t` is the flatness (0 = 2.5D, 1 = 2D). Builds the
   * merged geometry the first time it is actually needed — a map that never
   * leaves 2.5D never pays for it — and fades the layer in with `t`.
   */
  update(t: number, world: WorldModel | null, params: RenderParams, mats: MaterialFactory, styles: ReadonlyMap<string, BuildingOverride>): void {
    if (t <= 0) {
      if (this.group.visible) {
        this.group.visible = false;
        this.applied = -1;
      }
      return;
    }
    if (this.dirty && world) this.build(world, params, mats, styles);
    this.apply(t);
  }

  /** Releases geometry and materials. */
  dispose(): void {
    clearGroup(this.group);
    for (const f of this.fills) f.mat.dispose();
    this.outline?.mat.dispose();
    this.fills = [];
    this.outline = null;
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------

  /** Merges every footprint into one fill mesh per colour plus one outline mesh. */
  private build(world: WorldModel, params: RenderParams, mats: MaterialFactory, styles: ReadonlyMap<string, BuildingOverride>): void {
    this.dispose();
    this.dirty = false;
    const byColor = new Map<number, BufferGeometry[]>();
    const outlines: BufferGeometry[] = [];
    const y = world.buildingBaseY + FILL_Y;
    for (const b of world.buildings) {
      const ring = b.footprint;
      if (ring.length < 3) continue;
      const color = buildingColor(params, b.ci, styles.get(b.id));
      const bucket = byColor.get(color);
      const cap = capGeometry(ring, y);
      if (bucket) bucket.push(cap);
      else byColor.set(color, [cap]);
      outlines.push(ribbonGeo(closed(ring), FLAT_OUTLINE_WIDTH, world.buildingBaseY + OUTLINE_Y));
    }
    // The overview's un-modelled buildings (`WorldModel.buildingFills`) are
    // buildings on the map too — the 2D view is where they cost the least and
    // where leaving them out would show most, since nothing else is drawn in
    // their blocks. They take the first palette colour, having no `ci` of their
    // own, and the same outline as everything else.
    for (const f of world.buildingFills ?? []) {
      if (f.ring.length < 3) continue;
      const color = buildingColor(params, 0, undefined);
      const bucket = byColor.get(color);
      const cap = capGeometry(f.ring, y);
      if (bucket) bucket.push(cap);
      else byColor.set(color, [cap]);
      outlines.push(ribbonGeo(closed(f.ring), FLAT_OUTLINE_WIDTH, world.buildingBaseY + OUTLINE_Y));
    }
    let order = 10;
    for (const [color, geos] of byColor) {
      const c = flatColorsFor(color);
      const mat = mats.basic({ color: c.fill, transparent: true, opacity: 0, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -6 });
      this.fills.push({ mesh: this.add(mergeFlat(geos), mat, order++), mat });
    }
    if (outlines.length) {
      // One outline colour for the whole layer: the stroke is a map convention, not a per-building
      // property, and a single merged mesh keeps the layer at "one draw call per fill colour + one".
      const c = flatColorsFor(cssHexToNumber(params.palette[0]!));
      const mat = mats.basic({ color: c.outline, transparent: true, opacity: 0, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -8 });
      this.outline = { mesh: this.add(mergeFlat(outlines), mat, order), mat };
    }
    this.applied = -1;
  }

  private add(geo: BufferGeometry, mat: MeshBasicMaterial, renderOrder: number): Mesh {
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = renderOrder;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Building picking in the 2D view resolves the ground point against the footprints
    // (`BuildingRenderer.pickAt`), so the merged meshes never need to be raycast.
    mesh.raycast = noRaycast;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Fades the layer in over the second half of the transition. The extruded
   * buildings are still shrinking through the first half; bringing the fill up
   * underneath them at the same time would only double the overdraw while
   * nothing of it is visible.
   */
  private apply(t: number): void {
    if (t === this.applied) return;
    this.applied = t;
    const k = t <= FADE_IN_AT ? 0 : (t - FADE_IN_AT) / (1 - FADE_IN_AT);
    this.group.visible = k > 0;
    for (const f of this.fills) f.mat.opacity = k;
    if (this.outline) this.outline.mat.opacity = k;
  }
}

/** A ring as an explicitly closed polyline (the ribbon builder does not close it itself). */
function closed(ring: readonly Vec2[]): Vec2[] {
  const first = ring[0]!, last = ring[ring.length - 1]!;
  const out = [...ring];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push(first);
  return out;
}
