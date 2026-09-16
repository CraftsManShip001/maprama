/**
 * Part-2 feature wiring: characters, vehicles, travel, location, drops,
 * geofences, traffic, labels, map UI, overlay anchors and throttled
 * subscriptions, built on the {@link SceneApi}.
 *
 * Handlers are registered by the engine (see `engine.ts`) and delegate here.
 * Simulation runs in `onFrame` (before the camera update); DOM projection
 * (labels, name tags, overlay positions, scale bar) runs in `onBeforeRender`
 * (after the camera update) so screen positions never lag a frame.
 *
 * Deferred state: geofences, drop layers and characters sent before a world
 * is loaded are kept and applied when it loads. On a new world, running
 * trips are cancelled (`travel:cancel`), characters keep their geographic
 * position, drop layers and geofences are re-projected and `labelsIndex` is
 * sent again.
 *
 * @module
 */

import type {
  CharacterSpec,
  GeofenceSpec,
  InfoCardSpec,
  LabelContent,
  LocationFix,
  LocationSourceKind,
  OverlayAnchor,
  Projection,
  SetDropLayerCommand,
  SetMarkerLayerCommand,
  SubscriptionTopic,
  TravelMode,
  LngLat,
} from '@maprama/protocol';
import { Group } from 'three';
import { EngineError } from '../bridge/dispatcher.js';
import { OverlayTracker, ThrottledTopic, type TrackedPosition } from '../bridge/subscriptions.js';
import type { CameraController } from '../core/camera.js';
import { CharacterManager, headingFromYaw, realSpeedMps, type Character } from '../game/characters.js';
import { DropCollector, DropVisuals } from '../game/drops.js';
import { groundYFor } from '../game/follower.js';
import { GeofenceTracker, GeofenceVisuals } from '../game/geofences.js';
import { locationTrip, LocationService, type SmoothedFix } from '../game/location.js';
import { AmbientTraffic } from '../game/traffic.js';
import { TravelManager } from '../game/travel.js';
import { ensureLabelStyles } from '../labels/dom-styles.js';
import { LabelController } from '../labels/controller.js';
import { hudExclusions, overlaps, type Box } from '../labels/index.js';
import { defaultCardHeightMeters, InfoCards, type InfoCardAnchorPoint } from '../labels/info-card.js';
import { MarkerLayers, type MarkerPress } from '../labels/markers.js';
import { resolveWorldAnchor, type AnchorContext } from '../labels/anchor.js';
import type { SceneApi, SubscriptionHandler } from '../scene-api.js';
import { Attribution } from '../ui/attribution.js';
import { LocationPuck } from '../ui/puck.js';
import { ScaleBar } from '../ui/scalebar.js';
import { ZoomButtons } from '../ui/zoom.js';
import type { WorldModel } from '../world/model.js';

/** Minimum half size (CSS px) of the location puck's marker used for the HUD overlap test. */
const PUCK_HUD_HALF_PX = 14;

/** Location estimates farther than this (world units) teleport the character. */
const TELEPORT_UNITS = 40;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Features {
  readonly chars: CharacterManager;
  readonly travel: TravelManager;
  readonly location: LocationService;
  readonly collector = new DropCollector();
  readonly dropVisuals: DropVisuals;
  readonly fences = new GeofenceTracker();
  readonly fenceVisuals = new GeofenceVisuals();
  readonly traffic = new AmbientTraffic();
  readonly labels: LabelController;
  readonly markers: MarkerLayers;
  readonly infoCards: InfoCards;
  readonly puck = new LocationPuck();
  readonly positionTopic = new ThrottledTopic();
  readonly progressTopic = new ThrottledTopic();
  private readonly routes = new Group();
  private readonly overlayTracker = new OverlayTracker();
  private anchors: OverlayAnchor[] = [];
  /** Anchor coordinates in world units; only a new anchor set or a new projection changes them. */
  private readonly anchorPoints: { id: string; x: number; z: number }[] = [];
  /** Reused scratch batch for the overlay projection (see {@link projectOverlays}). */
  private readonly overlayBatch: TrackedPosition[] = [];
  private content: Record<string, LabelContent> = {};
  private dropLayers = new Map<string, SetDropLayerCommand>();
  private markerBoxes: Box[] = [];
  private infoCardBoxes: Box[] = [];
  private geofenceSpecs: GeofenceSpec[] = [];
  private pendingChars: CharacterSpec[] = [];
  private lastPosition = new Map<string, string>();
  private proj: Projection | null = null;
  private ui: { root: HTMLDivElement; scale: ScaleBar; zoom: ZoomButtons; attribution: Attribution } | null = null;
  /** Last content inset written to the ornament layer's CSS variables. */
  private insetVars = '';
  private readonly offs: (() => void)[] = [];
  /** Active render sources currently held, by tag (see {@link hold}). */
  private readonly holds = new Map<string, () => void>();

  constructor(private readonly scene: SceneApi) {
    const emitError = (code: string, message: string): void => scene.emit({ type: 'error', code, message, fatal: false });
    this.chars = new CharacterManager(scene, { onModelError: (id, uri, err) => emitError('model_load_failed', `character ${id}: failed to load ${uri}: ${errMessage(err)}`) });
    this.dropVisuals = new DropVisuals(scene, { onModelError: (key, uri, err) => emitError('model_load_failed', `drop ${key.replace('\0', '/')}: failed to load ${uri}: ${errMessage(err)}`) });
    this.travel = new TravelManager({
      world: () => scene.world(),
      projection: () => scene.projection(),
      materials: scene.materials,
      emit: (e) => scene.emit(e),
      overlayParent: this.routes,
      groundY: () => this.groundY(),
    });
    this.location = new LocationService({
      world: () => scene.world(),
      toWorld: (ll) => scene.toWorld(ll),
      onFix: (fix) => this.onLocationFix(fix),
      onError: emitError,
      now: () => performance.now() / 1000,
    });
    this.labels = new LabelController(scene);
    this.markers = new MarkerLayers(
      () => this.labels.domLayer(),
      (press) => this.emitMarkerPress(press),
    );
    this.infoCards = new InfoCards(
      () => this.labels.domLayer(),
      (press) => scene.emit(press.actionId === undefined
        ? { type: 'infoCard:press', id: press.id }
        : { type: 'infoCard:press', id: press.id, actionId: press.actionId }),
      (id) => scene.emit({ type: 'infoCard:dismiss', id }),
      (spec) => this.resolveInfoCardAnchor(spec),
      (buildingId) => scene.building(buildingId)?.top.y ?? null,
    );
    this.routes.name = 'routes';
    scene.groups.dynamic.add(this.traffic.group, this.fenceVisuals.group, this.routes, this.chars.group, this.dropVisuals.group, this.puck.group);

    this.offs.push(
      scene.onWorldLoad((w) => this.worldLoaded(w)),
      scene.onThemeChange((p) => {
        this.chars.applyOutline(p.outline);
        this.chars.onThemeChange();
        this.dropVisuals.onThemeChange();
        this.labels.themeChanged();
      }),
      scene.onFrame((dt, t) => this.frame(dt, t)),
      scene.onBeforeRender(() => this.beforeRender()),
      scene.registerFollowResolver((id) => (this.chars.get(id) ? () => this.followPoint(id) : null)),
    );
  }

  /** Subscription handlers for the part-2 topics. */
  topic(topic: Exclude<SubscriptionTopic, 'camera:change'>): SubscriptionHandler {
    const t = topic === 'character:position' ? this.positionTopic : this.progressTopic;
    return {
      subscribe: (id, throttleMs) => {
        t.subscribe(id, throttleMs);
        if (topic === 'character:position') this.lastPosition.clear();
      },
      unsubscribe: (id) => t.unsubscribe(id),
    };
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  labelsChanged(): void {
    const changed = this.labels.indexIfChanged();
    if (changed) this.scene.emit({ type: 'labelsIndex', labels: changed });
  }

  setLabelContent(entries: Record<string, LabelContent>): void {
    this.content = { ...entries };
    this.labels.contentChanged();
  }

  setLocationSource(kind: LocationSourceKind): void {
    this.location.setKind(kind);
  }

  pushLocation(fix: LocationFix): void {
    this.location.push(fix);
  }

  upsertCharacters(specs: CharacterSpec[]): void {
    const world = this.scene.world();
    if (!world) {
      for (const s of specs) {
        const i = this.pendingChars.findIndex((p) => p.id === s.id);
        if (i >= 0) this.pendingChars[i] = { ...this.pendingChars[i]!, ...s };
        else this.pendingChars.push({ ...s });
      }
      return;
    }
    try {
      this.chars.upsert(specs, world, this.scene.projection());
    } catch (e) {
      const code = (e as { code?: string }).code;
      throw new EngineError(code ?? 'internal', errMessage(e));
    }
    for (const s of specs) {
      if (s.position) this.lastPosition.delete(s.id);
      // `null` restores the default follow mode (not driven by the location source), like `none`.
      if ((s.follow === 'none' || s.follow === null) && !this.travel.isTraveling(s.id)) this.chars.get(s.id)?.follower.setTrip([]);
    }
    const last = this.location.last;
    if (last) for (const s of specs) if (s.follow === 'location') this.driveToFix(this.chars.get(s.id), last);
  }

  removeCharacters(ids: string[]): void {
    this.pendingChars = this.pendingChars.filter((p) => !ids.includes(p.id));
    for (const id of ids) {
      if (!this.chars.get(id)) continue;
      this.travel.cancel(id);
      if (this.scene.camera.followingId === id) this.scene.camera.follow(null);
      this.positionTopic.reset(id);
      this.progressTopic.reset(id);
      this.lastPosition.delete(id);
    }
    this.chars.remove(ids);
  }

  startTravel(requestId: string, characterId: string, to: LngLat, modes: TravelMode[], timeScale = 1): void {
    if (!this.scene.world()) throw new EngineError('not_ready', 'no world loaded (send init first)');
    const ch = this.chars.get(characterId);
    if (!ch) throw new EngineError('unknown_character', `unknown character "${characterId}"`);
    this.travel.start(requestId, ch, to, modes, timeScale);
  }

  cancelTravel(characterId: string): void {
    if (!this.chars.get(characterId)) throw new EngineError('unknown_character', `unknown character "${characterId}"`);
    this.travel.cancel(characterId);
  }

  setDropLayer(cmd: SetDropLayerCommand): void {
    this.dropLayers.set(cmd.layerId, cmd);
    const world = this.scene.world();
    if (world) this.applyDropLayer(cmd, world);
  }

  removeDropLayer(layerId: string): void {
    this.dropLayers.delete(layerId);
    for (const d of this.collector.removeLayer(layerId)) this.dropVisuals.remove(d);
  }

  /**
   * Creates or replaces a marker layer (markers are matched by id, so a
   * colour-only change is a field write). The frame that draws the result comes
   * from the dispatcher's per-command render request, so an idle map repaints.
   */
  setMarkerLayer(cmd: SetMarkerLayerCommand): void {
    this.markers.setLayer(cmd, this.scene.world() ? this.scene.projection() : null, this.anchorContext());
  }

  removeMarkerLayer(layerId: string): void {
    this.markers.removeLayer(layerId);
  }

  /**
   * Creates or replaces one info card. The engine only draws it: opening it on
   * a press and moving the camera (`focusOn`) stay the host's decisions.
   */
  setInfoCard(card: InfoCardSpec): void {
    this.infoCards.setCard(card, performance.now());
  }

  removeInfoCard(id: string): void {
    this.infoCards.removeCard(id, performance.now());
  }

  /** The resolved world anchor of an info card (`focusOn { infoCardId }`). */
  infoCardAnchor(id: string): InfoCardAnchorPoint | null {
    const a = this.infoCards.anchorOf(id);
    if (!a) return null;
    // Same refresh as the draw pass: a roof anchor follows the zoom-out squash.
    if (a.buildingId !== undefined) {
      const y = this.scene.building(a.buildingId)?.top.y;
      if (y !== undefined) a.baseY = y;
    }
    return a;
  }

  /**
   * The world's buildings and their current roof heights, as the shared anchor
   * lookup wants them (`labels/anchor.ts`). `null` without a world.
   */
  anchorContext(): AnchorContext | null {
    const world = this.scene.world();
    if (!world) return null;
    return {
      buildings: world.buildings,
      roofY: (id) => this.scene.building(id)?.top.y ?? null,
      groundY: this.groundY(),
    };
  }

  /**
   * Resolves a card's anchor in world units through the shared lookup, so a
   * card, a marker and a `snapToBuilding` request all pick the same building.
   * Cards never snap: a card is opened *for* a coordinate the app chose.
   */
  private resolveInfoCardAnchor(spec: InfoCardSpec): InfoCardAnchorPoint | null {
    const ctx = this.anchorContext();
    if (!ctx) return null;
    const proj = this.scene.projection();
    const p = proj.toWorld(spec.coordinate);
    const probe = resolveWorldAnchor(ctx, { x: p.x, z: p.z, mode: spec.anchor ?? 'auto', height: 0 });
    const meters = spec.heightMeters ?? defaultCardHeightMeters(probe.buildingId !== undefined);
    const anchor: InfoCardAnchorPoint = { x: probe.x, z: probe.z, baseY: probe.baseY, height: proj.metersToUnits(meters) };
    if (probe.buildingId !== undefined) anchor.buildingId = probe.buildingId;
    return anchor;
  }

  /**
   * Emits `marker:press` when a press at CSS pixel coordinates hits a visible
   * marker. The engine calls this before picking buildings or the ground, so a
   * marker press never also produces `building:press` / `map:press`.
   */
  pressMarker(x: number, y: number): boolean {
    const hit = this.markers.hitTest(x, y);
    if (!hit) return false;
    this.emitMarkerPress(hit);
    return true;
  }

  private emitMarkerPress(press: MarkerPress): void {
    this.scene.emit({
      type: 'marker:press',
      layerId: press.layerId,
      markerId: press.markerId,
      coordinate: press.coordinate,
      point: { x: press.point.x, y: press.point.y },
    });
  }

  setGeofences(list: GeofenceSpec[]): void {
    this.geofenceSpecs = list.map((g) => ({ ...g }));
    const world = this.scene.world();
    if (world) this.applyGeofences(world);
  }

  setOverlayAnchors(anchors: OverlayAnchor[]): void {
    this.anchors = anchors.map((a) => ({ id: a.id, coordinate: { ...a.coordinate } }));
    this.placeAnchors();
    this.overlayTracker.invalidate();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const release of this.holds.values()) release();
    this.holds.clear();
    this.location.dispose();
    this.travel.dispose();
    this.chars.dispose();
    this.dropVisuals.dispose();
    this.fenceVisuals.clear();
    this.traffic.clear();
    this.markers.dispose();
    this.infoCards.dispose();
    this.labels.dispose();
    this.puck.dispose();
    if (this.ui) {
      this.ui.scale.dispose();
      this.ui.zoom.dispose();
      this.ui.attribution.dispose();
      this.ui.root.remove();
    }
    this.scene.groups.dynamic.remove(this.traffic.group, this.fenceVisuals.group, this.routes, this.chars.group, this.dropVisuals.group, this.puck.group);
  }

  // ---------------------------------------------------------------------------

  private groundY(): number {
    return groundYFor(this.scene.world()?.kind);
  }

  /**
   * Camera follow target: the ground point on the view ray through the
   * character, so airborne characters (plane legs) stay centered on screen.
   */
  private followPoint(id: string): { x: number; z: number } | null {
    const c = this.chars.get(id);
    if (!c) return null;
    const alt = Math.max(0, c.y - this.groundY());
    if (alt < 0.01) return { x: c.x, z: c.z };
    const o = this.scene.camera.orbit, p = (o.pitch * Math.PI) / 180, b = (o.bearing * Math.PI) / 180;
    const d = alt * Math.tan(p);
    return { x: c.x + Math.sin(b) * d, z: c.z - Math.cos(b) * d };
  }

  private worldLoaded(world: WorldModel): void {
    const newProj = this.scene.projection();
    this.travel.cancelAll();
    if (this.proj) this.chars.rebase(this.proj, newProj, world);
    this.proj = newProj;
    if (this.pendingChars.length) {
      const pending = this.pendingChars;
      this.pendingChars = [];
      this.upsertCharacters(pending);
    }
    this.location.worldChanged(world);
    this.location.setKind(this.scene.locationSource());
    for (const d of this.collector.layerIds()) for (const s of this.collector.removeLayer(d)) this.dropVisuals.remove(s);
    for (const cmd of this.dropLayers.values()) this.applyDropLayer(cmd, world);
    this.markers.reproject(newProj, this.anchorContext());
    this.infoCards.reproject();
    this.applyGeofences(world);
    this.traffic.build(world, this.scene.materials, this.scene.textures().glow);
    this.lastPosition.clear();
    // A new world means a new projection: the cached anchor positions are in the old one.
    this.placeAnchors();
    this.overlayTracker.invalidate();
    this.scene.emit({ type: 'labelsIndex', labels: this.labels.worldChanged(world, newProj) });
  }

  private applyDropLayer(cmd: SetDropLayerCommand, world: WorldModel): void {
    const proj = this.scene.projection();
    const diff = this.collector.setLayer(
      cmd.layerId,
      cmd.drops.map((spec) => ({ spec, ...proj.toWorld(spec.coordinate) })),
      cmd.collectRadiusMeters / world.unitMeters,
      cmd.collectorIds,
    );
    for (const d of diff.removed) this.dropVisuals.remove(d);
    for (const d of diff.added) this.dropVisuals.add(d, groundYFor(world.kind));
    for (const d of diff.moved) this.dropVisuals.move(d);
  }

  private applyGeofences(world: WorldModel): void {
    const proj = this.scene.projection();
    this.fences.set(this.geofenceSpecs.map((g) => ({ id: g.id, ...proj.toWorld(g.center), r: g.radiusMeters / world.unitMeters })));
    this.fenceVisuals.build(this.fences.list(), groundYFor(world.kind));
  }

  private onLocationFix(fix: SmoothedFix & { raw: { x: number; z: number } }): void {
    for (const ch of this.chars.chars.values()) if (ch.spec.follow === 'location') this.driveToFix(ch, fix);
    // A `device` watch or an external `pushLocation` arrives outside any frame hook.
    this.scene.requestRender();
  }

  private driveToFix(ch: Character | undefined, fix: { x: number; z: number }): void {
    const world = this.scene.world();
    if (!ch || !world || this.travel.isTraveling(ch.id)) return;
    if (Math.hypot(fix.x - ch.x, fix.z - ch.z) > TELEPORT_UNITS) {
      ch.follower.setTrip([]);
      ch.x = fix.x;
      ch.z = fix.z;
      return;
    }
    const trip = locationTrip(world.graph, { x: ch.x, z: ch.z }, fix);
    ch.follower.onArrive = null;
    ch.follower.setTrip(trip.pts.length > 1 ? [{ mode: 'walk', pts: trip.pts }] : [], trip.speed);
  }

  /**
   * Acquires / releases the active render source `tag` so that it is held
   * exactly while `want` is true (idempotent).
   */
  private hold(tag: string, want: boolean): void {
    const release = this.holds.get(tag);
    if (want === !!release) return;
    if (want) this.holds.set(tag, this.scene.addActiveSource(tag));
    else {
      release!();
      this.holds.delete(tag);
    }
  }

  /**
   * Keeps the render loop awake exactly while something still moves. Anything
   * that starts moving from outside a frame (a command, a gesture, an async
   * model) asks for one frame, and this picks the sources up on that frame.
   *
   * Runs at the end of `frame`, so every predicate describes the frame that
   * was just stepped. The label source is handled in `beforeRender` instead,
   * because a holo card can only be marked as fading out there.
   */
  private updateSources(): void {
    const rm = this.scene.reduceMotion;
    this.hold('chars', this.chars.animating);
    this.hold('travel', this.travel.active);
    this.hold('drops', this.dropVisuals.animating);
    this.hold('geofences', this.fenceVisuals.animating(rm));
    this.hold('traffic', this.traffic.animating);
    // The simulated walker only matters while a character follows it: otherwise its fixes
    // change nothing on screen, and stepping it would keep a demo map rendering forever.
    this.hold('location', this.location.animating && this.hasLocationFollower());
  }

  private hasLocationFollower(): boolean {
    for (const c of this.chars.chars.values()) if (c.spec.follow === 'location') return true;
    return false;
  }

  private frame(dt: number, t: number): void {
    const world = this.scene.world();
    if (!world) {
      this.updateSources();
      return;
    }
    const proj = this.scene.projection();
    this.location.step(dt);
    this.chars.step(dt, t, world.unitMeters);
    const list = [...this.chars.chars.values()];
    const positions = list.map((c) => ({ id: c.id, x: c.x, z: c.z, isPlayer: !!c.spec.isPlayer }));
    for (const { event, drop } of this.collector.check(positions, (p) => proj.toLngLat(p))) {
      this.dropVisuals.collect(drop);
      this.scene.emit(event);
    }
    for (const e of this.fences.update(positions)) this.scene.emit(e);
    const rm = this.scene.reduceMotion;
    this.dropVisuals.step(dt, t);
    this.fenceVisuals.step(t, rm);
    this.travel.step(t, rm);
    const params = this.scene.params();
    this.traffic.step(dt, params.street.traffic, params.lights > 0);
    const player = this.chars.player();
    const ui = this.scene.ui();
    const acc = player && player.spec.follow === 'location' && this.location.last ? this.location.last.accuracy : null;
    if (player) this.puck.update(!!ui.locationPuck, player.x, this.groundY(), player.z, player.yaw, this.scene.camera.orbit.distance, acc);
    else this.puck.update(false, 0, 0, 0, 0, 0, null);

    const now = performance.now();
    if (this.positionTopic.active) {
      for (const c of list) {
        if (!this.positionTopic.wants(c.id)) continue;
        const heading = headingFromYaw(c.yaw), speed = realSpeedMps(c.speed, world.unitMeters);
        const key = `${c.x.toFixed(3)}|${c.z.toFixed(3)}|${heading.toFixed(1)}|${speed.toFixed(2)}`;
        if (this.lastPosition.get(c.id) === key || !this.positionTopic.due(c.id, now)) continue;
        this.lastPosition.set(c.id, key);
        this.scene.emit({ type: 'character:position', id: c.id, coordinate: proj.toLngLat({ x: c.x, z: c.z }), headingDeg: heading, speedMps: speed });
      }
    }
    this.travel.progress(this.progressTopic, now);
    this.updateSources();
  }

  private beforeRender(): void {
    this.project();
    // A holo card is only marked as fading out here, so its source is picked up after projection
    // (in `frame` it would be one frame stale, and the card would never leave the layout).
    this.hold('labels', this.labels.animating);
    // Info cards hold a source only while a card plays its entrance or exit transition: a card
    // that is simply on screen must not keep the loop awake (see `scripts/idle-frames.mjs`).
    this.hold('infoCards', this.infoCards.animating);
  }

  private project(): void {
    const cam = this.scene.camera;
    const now = performance.now();
    this.projectOverlays(cam, now);
    const world = this.scene.world();
    if (!world) return;
    const ui = this.scene.ui();
    const exclusions = hudExclusions(cam.width, cam.height, ui, cam.inset);
    // Info cards win every collision: they are placed first, never dropped, and their boxes
    // become exclusions for the markers and then for the labels.
    this.infoCardBoxes = this.infoCards.update(cam, this.scene.projection(), now);
    const beforeMarkers = this.infoCardBoxes.length ? [...exclusions, ...this.infoCardBoxes] : exclusions;
    this.markerBoxes = this.markers.update(cam, beforeMarkers, this.groundY(), (id) => this.scene.building(id)?.top.y ?? null);
    const reserved = this.infoCardBoxes.length ? [...this.infoCardBoxes, ...this.markerBoxes] : this.markerBoxes;
    this.labels.update(this.content, ui, this.groundY(), now, reserved);
    if (this.chars.chars.size) this.chars.updateTags(cam, this.scene.zoomOutFactor(), this.labels.domLayer(), exclusions);
    if (this.puck.group.visible) {
      // Keep the puck out of the HUD margins (attribution, scale bar, zoom buttons, screen edges). The marker
      // grows with the camera distance, so the test uses its projected size (at least PUCK_HUD_HALF_PX).
      const p = this.puck.group.position, s = cam.worldToScreen(p.x, p.y, p.z);
      if (s.visible) {
        const half = this.puck.screenHalfSize(cam, PUCK_HUD_HALF_PX);
        const box = { x: s.x, y: s.y, hw: half, hh: half };
        if (exclusions.some((e) => overlaps(e, box))) this.puck.group.visible = false;
      }
    }
    const wantUi = !!(ui.scaleBar || ui.zoomButtons || ui.attribution);
    if (wantUi || this.ui) {
      const u = this.ensureUi();
      u.root.classList.toggle('night', this.scene.params().lights > 0.8);
      this.applyInsetVars(u.root, cam.inset);
      u.scale.update(!!ui.scaleBar, cam, world.unitMeters);
      u.zoom.update(!!ui.zoomButtons);
      u.attribution.update(!!ui.attribution, world.attribution);
    }
  }

  /** Caches the world position of every overlay anchor for the current projection. */
  private placeAnchors(): void {
    const proj = this.scene.projection(), out = this.anchorPoints, anchors = this.anchors;
    out.length = anchors.length;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!, w = proj.toWorld(a.coordinate), e = out[i];
      if (e) {
        e.id = a.id;
        e.x = w.x;
        e.z = w.z;
      } else out[i] = { id: a.id, x: w.x, z: w.z };
    }
  }

  /**
   * Screen positions of the overlay anchors, for `overlay:positions`.
   *
   * The event is throttled to one batch per `OVERLAY_INTERVAL_MS`, so the
   * throttle is asked **first**: inside the window this frame does no anchor
   * work at all. When a batch is due it is written into a reused buffer over
   * cached world positions (an anchor's world position only changes when the
   * anchor set or the projection does), and fresh objects are only allocated
   * for the batches that are really sent — the payload leaves the engine, so it
   * cannot be a buffer that the next frame overwrites.
   *
   * The event keeps carrying **every** anchor, not only the ones that moved:
   * hosts are allowed to read it as the complete current state, and an
   * off-screen anchor's `x`/`y` is used as well (`<MapOverlay
   * hideWhenOffscreen={false}>` positions its view with it), so neither
   * dropping unchanged entries nor faking coordinates for invisible anchors
   * would be a compatible change.
   */
  private projectOverlays(cam: CameraController, now: number): void {
    const anchors = this.anchorPoints;
    if (!anchors.length || !this.overlayTracker.due(now)) return;
    const batch = this.overlayBatch;
    batch.length = anchors.length;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      let e = batch[i];
      if (!e) batch[i] = e = { id: a.id, x: 0, y: 0, visible: false };
      else e.id = a.id;
      cam.worldToScreen(a.x, 0, a.z, e);
    }
    if (!this.overlayTracker.update(batch, now)) return;
    this.scene.emit({ type: 'overlay:positions', positions: batch.map((p) => ({ id: p.id, x: p.x, y: p.y, visible: p.visible })) });
  }

  /**
   * Pushes `ui.contentInset` to the ornament layer as CSS custom properties.
   * The ornaments are positioned in CSS (`dom-styles.ts`), so the inset is one
   * `calc()` term in each of them — the scale bar, the zoom buttons and, the
   * reason this exists, the attribution: while `ui.attribution` is on the
   * engine keeps drawing it and the inset moves it out from under app chrome,
   * instead of the app turning it off and redrawing a copy that would go stale
   * the moment the library changes its wording or its sources.
   */
  private applyInsetVars(root: HTMLElement, inset: Readonly<{ top: number; right: number; bottom: number; left: number }>): void {
    const key = `${inset.top}|${inset.right}|${inset.bottom}|${inset.left}`;
    if (key === this.insetVars) return;
    this.insetVars = key;
    root.style.setProperty('--mpr-inset-top', `${inset.top}px`);
    root.style.setProperty('--mpr-inset-right', `${inset.right}px`);
    root.style.setProperty('--mpr-inset-bottom', `${inset.bottom}px`);
    root.style.setProperty('--mpr-inset-left', `${inset.left}px`);
  }

  private ensureUi(): NonNullable<Features['ui']> {
    if (!this.ui) {
      const doc = this.scene.overlayLayer.ownerDocument;
      ensureLabelStyles(doc);
      const root = doc.createElement('div');
      root.className = 'mpr-ui';
      this.scene.overlayLayer.appendChild(root);
      this.ui = { root, scale: new ScaleBar(root), zoom: new ZoomButtons(root, this.scene.camera), attribution: new Attribution(root) };
    }
    return this.ui;
  }
}
