/**
 * Label controller: owns the label index of the loaded world and drives the
 * active label style (`app` / `minimal` / `clean` / `sticker` DOM labels,
 * `holo` floating cards, `ground` / `sign` 3D labels) from `LabelsSpec`, the
 * host's custom content and the camera.
 *
 * Defaults when a `LabelsSpec` field is absent: labels enabled, style
 * `holo`, icon tiles `auto`, content `nameAndType`.
 *
 * @module
 */

import type { LabelContent, LabelInfo, LabelsSpec, LabelStyle, MapUiSpec, Projection } from '@maprama/protocol';
import type { SceneApi } from '../scene-api.js';
import type { WorldModel } from '../world/model.js';
import { DomLabels, ensureLabelStyles } from './dom-styles.js';
import { HoloLabels } from './holo.js';
import { buildLabelEntries, hudExclusions, iconTileFor, toLabelInfo, type Box, type DomLabelStyle, type LabelEntry } from './index.js';
import { WorldLabels3D } from './world3d.js';

export const DEFAULT_LABEL_STYLE: LabelStyle = 'holo';

/** Resolved label settings. */
export function resolveLabels(spec: LabelsSpec): Required<LabelsSpec> {
  return { enabled: spec.enabled ?? true, style: spec.style ?? DEFAULT_LABEL_STYLE, icons: spec.icons ?? 'auto', content: spec.content ?? 'nameAndType' };
}

const DOM_STYLES: readonly LabelStyle[] = ['app', 'minimal', 'clean', 'sticker'];

export class LabelController {
  entries: LabelEntry[] = [];
  private world: WorldModel | null = null;
  private layer: HTMLDivElement | null = null;
  private dom: DomLabels | null = null;
  private holo: HoloLabels | null = null;
  private world3d: WorldLabels3D | null = null;
  private domBuilt = false;
  private holoBuilt = false;
  private contentVersion = 0;
  private lastStyle = '';
  private lastIndexJson = '';

  constructor(private readonly scene: SceneApi) {}

  /** The DOM layer labels and name tags are drawn into (created on demand). */
  domLayer(): HTMLDivElement {
    if (!this.layer) {
      const doc = this.scene.overlayLayer.ownerDocument;
      ensureLabelStyles(doc);
      this.layer = doc.createElement('div');
      this.layer.className = 'mpr-labels';
      this.scene.overlayLayer.appendChild(this.layer);
    }
    return this.layer;
  }

  /** Rebuilds the index for a world; returns the `labelsIndex` payload when it changed (always on a new world). */
  worldChanged(world: WorldModel, proj: Projection): LabelInfo[] {
    this.world = world;
    this.entries = buildLabelEntries(world, proj);
    this.domBuilt = this.holoBuilt = false;
    this.world3d?.clear();
    const infos = this.entries.map(toLabelInfo);
    this.lastIndexJson = JSON.stringify(infos);
    return infos;
  }

  /** Index payload if it differs from the last reported one (`null` otherwise). */
  indexIfChanged(): LabelInfo[] | null {
    const infos = this.entries.map(toLabelInfo);
    const json = JSON.stringify(infos);
    if (json === this.lastIndexJson) return null;
    this.lastIndexJson = json;
    return infos;
  }

  contentChanged(): void {
    this.contentVersion++;
    this.dom?.invalidate();
    this.holo?.invalidate();
  }

  themeChanged(): void {
    this.dom?.invalidate();
    if (this.world3d) this.world3d.built = '';
  }

  /**
   * Per-frame update after the camera moved. `reserved` holds boxes already
   * taken by earlier passes (the marker layers, which are placed first), so
   * labels never cover a marker.
   */
  update(content: Readonly<Record<string, LabelContent>>, ui: MapUiSpec, groundY: number, now: number, reserved: readonly Box[] = []): void {
    const world = this.world;
    if (!world) return;
    const spec = resolveLabels(this.scene.labels());
    const params = this.scene.params();
    const night = params.lights > 0.8;
    const cam = this.scene.camera;
    const style = spec.enabled ? spec.style : null;
    const layer = this.domLayer();
    if (this.lastStyle !== `${style}`) {
      this.lastStyle = `${style}`;
      for (const s of ['minimal', 'sticker', 'clean']) layer.classList.toggle(`ls-${s}`, style === s);
      this.dom?.invalidate();
    }
    layer.classList.toggle('night', night);
    const tile = iconTileFor(spec.icons, night);
    for (const t of ['white', 'black', 'color']) layer.classList.toggle(`hi-${t}`, tile === t);
    const hud = hudExclusions(cam.width, cam.height, ui, cam.inset);
    const exclusions = reserved.length ? [...hud, ...reserved] : hud;

    if (style && DOM_STYLES.includes(style)) {
      if (!this.dom) this.dom = new DomLabels(layer);
      if (!this.domBuilt) { this.dom.build(this.entries); this.domBuilt = true; }
      this.dom.update(cam, style as DomLabelStyle, spec, content, this.scene.zoomOutFactor(), exclusions, now);
    } else this.dom?.hide();

    if (style === 'holo') {
      if (!this.holo) this.holo = new HoloLabels(layer);
      if (!this.holoBuilt) { this.holo.build(this.entries); this.holoBuilt = true; }
      this.holo.update(cam, spec.content, content, exclusions, groundY, now, this.scene.anchorHeightScale());
    } else this.holo?.hide();

    if (style === 'ground' || style === 'sign') {
      if (!this.world3d) {
        this.world3d = new WorldLabels3D(this.scene.container.ownerDocument);
        this.scene.groups.dynamic.add(this.world3d.group);
      }
      const key = `${style}|${spec.content}|${this.contentVersion}|${this.entries.length}`;
      if (this.world3d.built !== key) this.world3d.build(style, this.entries, world, this.scene.materials, spec.content, content, groundY, key);
      this.world3d.group.visible = true;
      this.world3d.step(cam.orbit.bearing);
    } else if (this.world3d) this.world3d.group.visible = false;
  }

  /**
   * True while the labels still need frames: a holo card that was hidden has
   * to be updated once more, 320 ms later, to leave the layout.
   */
  get animating(): boolean {
    return this.holo?.animating ?? false;
  }

  /** Currently shown holo label ids (tooling). */
  shownHolo(): string[] {
    return this.holo?.shownIds() ?? [];
  }

  dispose(): void {
    this.dom?.clear();
    this.holo?.clear();
    if (this.world3d) {
      this.world3d.clear();
      this.scene.groups.dynamic.remove(this.world3d.group);
    }
    this.layer?.remove();
  }
}
