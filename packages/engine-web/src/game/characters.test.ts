import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CharacterSpec, LngLat, Projection } from '@maprama/protocol';
import { AnimationClip, AnimationMixer, Box3, Group, Mesh, MeshBasicMaterial, Vector3, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { SceneApi } from '../scene-api.js';
import type { MaterialFactory } from '../theme/materials.js';
import type { WorldModel } from '../world/model.js';
import {
  CHARACTER_HEIGHT,
  CharacterManager,
  chooseAnimation,
  clipTimeScale,
  headingFromYaw,
  instantiateModel,
  MIN_CADENCE,
  mergeCharacterSpec,
  nameTagAnchor,
  normalizeCharacterSpec,
  normalizeModel,
  realSpeedMps,
  resolveClips,
  WALK_CADENCE_SPEED,
  walkCadence,
} from './characters.js';
import { playbackSpeeds } from './follower.js';
import { buildVehicles, PLANE_SCALE, PLANE_TOP_Y, type PartFn } from './vehicles.js';

describe('clearing spec fields (null = back to the default)', () => {
  it('normalizes null and undefined fields away without touching the input', () => {
    const spec: CharacterSpec = {
      id: 'a', model: null, name: null, color: '#fff', follow: null, isPlayer: null, scale: null, animations: null, showNameTag: null, position: { lng: 1, lat: 2 },
    };
    const copy = structuredClone(spec);
    expect(normalizeCharacterSpec(spec)).toStrictEqual({ id: 'a', color: '#fff', position: { lng: 1, lat: 2 } });
    expect(spec).toStrictEqual(copy);
    expect(Object.keys(normalizeCharacterSpec({ id: 'b', name: undefined }))).toEqual(['id']);
  });

  it('merges upserts: absent keeps a field, null clears it, a value replaces it', () => {
    const current = normalizeCharacterSpec({
      id: 'a', name: 'A', color: '#fff', scale: 2, showNameTag: true, animations: { walk: 'W' }, isPlayer: true, follow: 'location', model: { uri: 'x.glb' },
    });
    expect(mergeCharacterSpec(current, { id: 'a' })).toStrictEqual(current);
    expect(mergeCharacterSpec(current, { id: 'a', name: undefined })).toStrictEqual(current);
    expect(mergeCharacterSpec(current, { id: 'a', name: null, scale: 3, animations: null, model: null })).toStrictEqual({
      id: 'a', color: '#fff', scale: 3, showNameTag: true, isPlayer: true, follow: 'location',
    });
    expect(mergeCharacterSpec(current, { id: 'a', color: null, follow: null, isPlayer: null, showNameTag: null })).toStrictEqual({
      id: 'a', name: 'A', scale: 2, animations: { walk: 'W' }, model: { uri: 'x.glb' },
    });
    expect(current.name).toBe('A');
  });
});

describe('CharacterManager.upsert with cleared fields (no WebGL)', () => {
  const scene = {
    materials: { make: (color: number) => new MeshBasicMaterial({ color }), ink: new MeshBasicMaterial() },
    silhouette: { createMaterial: (color: number) => new MeshBasicMaterial({ color }), addSilhouette: () => {} },
    params: () => ({ outline: false }),
  } as unknown as SceneApi;
  const world = { kind: 'procedural' } as unknown as WorldModel;
  const proj = { toWorld: (ll: LngLat) => ({ x: ll.lng, z: ll.lat }) } as unknown as Projection;
  const at = { lng: 1, lat: 2 };
  const manager = (): CharacterManager => new CharacterManager(scene, { onModelError: () => {} });
  const fakeTag = (text: string) => {
    const t = { textContent: text, removed: false, remove: () => { t.removed = true; } };
    return t;
  };

  it('re-runs the side effect of every cleared field', () => {
    const mgr = manager();
    const me = mgr.upsert([{ id: 'me', position: at, isPlayer: true, name: 'Me', color: '#ff0000', scale: 2, showNameTag: true, follow: 'location' }], world, proj)[0]!;
    mgr.ensureProcedural(me);
    expect(me.color).toBe(0xff0000);
    expect(me.root.scale.x).toBe(2);
    expect(mgr.player()).toBe(me);

    const tag = fakeTag('Me');
    me.tag = tag as unknown as HTMLDivElement;
    mgr.upsert([{ id: 'me', name: null }], world, proj);
    expect(tag.textContent).toBe('me');
    expect('name' in me.spec).toBe(false);

    const rig = me.procedural!.rig;
    mgr.upsert([{ id: 'me', color: null }], world, proj);
    expect(me.color).toBe(0x3f63d6); // default player color
    expect(me.procedural!.rig).not.toBe(rig); // procedural body rebuilt in the new color
    expect(tag.removed).toBe(true); // the tag is recreated with the default accent on the next frame
    expect(me.tag).toBeNull();

    const tag2 = fakeTag('me');
    me.tag = tag2 as unknown as HTMLDivElement;
    mgr.upsert([{ id: 'me', scale: null, showNameTag: null }], world, proj);
    expect(me.root.scale.x).toBe(1);
    expect(tag2.removed).toBe(true);
    expect(me.tag).toBeNull();

    mgr.upsert([{ id: 'me', follow: null }], world, proj);
    expect(me.spec).toStrictEqual({ id: 'me', position: at, isPlayer: true });
  });

  it('gives a character created without a model its procedural body', () => {
    const mgr = manager();
    const npc = mgr.upsert([{ id: 'npc', position: at }], world, proj)[0]!;
    expect(npc.procedural).not.toBeNull();
    expect(npc.procedural!.rig.visible).toBe(true);
  });

  it('treats isPlayer: null as false for the one-player rule and the procedural body', () => {
    const mgr = manager();
    const me = mgr.upsert([{ id: 'me', position: at, isPlayer: true }], world, proj)[0]!;
    mgr.ensureProcedural(me);
    const rig = me.procedural!.rig;
    expect(() => mgr.upsert([{ id: 'other', position: at, isPlayer: true }], world, proj)).toThrow(/at most one/);
    mgr.upsert([{ id: 'me', isPlayer: null }, { id: 'other', position: at, isPlayer: true }], world, proj);
    expect(mgr.player()?.id).toBe('other');
    expect('isPlayer' in me.spec).toBe(false);
    expect(me.procedural!.rig).not.toBe(rig); // player cap / backpack removed
  });

  it('re-resolves the clips of a loaded model when animations change or are cleared', () => {
    const mgr = manager();
    const me = mgr.upsert([{ id: 'me', position: at, animations: { walk: 'Strut' } }], world, proj)[0]!;
    const all = ['idle', 'walk', 'Strut'].map((name) => new AnimationClip(name, 1, []));
    const clips = resolveClips(all.map((c) => c.name), me.spec.animations);
    expect(clips.walk).toBe('Strut');
    me.model = { wrap: new Group(), mixer: new AnimationMixer(new Group()), all, clips, actions: {}, current: 'walk' };

    mgr.upsert([{ id: 'me', name: 'x' }], world, proj);
    expect(me.model.current).toBe('walk'); // same mapping: untouched

    mgr.upsert([{ id: 'me', animations: null }], world, proj);
    expect(me.model.clips).toEqual({ idle: 'idle', walk: 'walk' });
    expect(me.model.actions.walk?.getClip().name).toBe('walk');
    expect(me.model.current).toBeNull();

    mgr.upsert([{ id: 'me', animations: { idle: 'Strut' } }], world, proj);
    expect(me.model.clips.idle).toBe('Strut');
  });
});

describe('clip-name mapping', () => {
  it('uses conventional names exactly, case-insensitively, then as a name segment', () => {
    expect(resolveClips(['idle', 'Walk', 'Armature|Run', 'Take 001'])).toEqual({ idle: 'idle', walk: 'Walk', run: 'Armature|Run' });
  });

  it('prefers an explicit mapping when the clip exists; falls back to the convention otherwise', () => {
    const clips = ['Idle', 'Walking', 'Running', 'Wave', 'walk'];
    expect(resolveClips(clips, { walk: 'Walking', run: 'Running', ride: 'Missing' })).toEqual({ idle: 'Idle', walk: 'Walking', run: 'Running', wave: 'Wave' });
    expect(resolveClips(clips, { walk: 'Nope' }).walk).toBe('walk');
    expect(resolveClips([], { idle: 'Idle' })).toEqual({});
  });

  it('chooses animations by mode and speed with fallbacks', () => {
    const all = { idle: 'i', walk: 'w', run: 'r', ride: 'b', wave: 'v' };
    expect(chooseAnimation('walk', 0, all)).toBe('idle');
    expect(chooseAnimation('walk', WALK_CADENCE_SPEED, all)).toBe('walk');
    expect(chooseAnimation('walk', WALK_CADENCE_SPEED * 2, all)).toBe('run');
    expect(chooseAnimation('bike', 5, all)).toBe('ride');
    expect(chooseAnimation('car', 5, all)).toBe('ride');
    expect(chooseAnimation('plane', 20, all)).toBe('idle');
    expect(chooseAnimation('walk', WALK_CADENCE_SPEED * 2, { idle: 'i', walk: 'w' })).toBe('walk');
    expect(chooseAnimation('bike', 5, { walk: 'w' })).toBeNull();
    expect(chooseAnimation('walk', 3, { run: 'r' })).toBe('run');
  });

  it('reports heading clockwise from north and realistic speeds', () => {
    expect(headingFromYaw(Math.atan2(0, -1))).toBeCloseTo(0, 9); // moving north (−z)
    expect(headingFromYaw(Math.atan2(1, 0))).toBeCloseTo(90, 9); // east
    expect(headingFromYaw(Math.atan2(0, 1))).toBeCloseTo(180, 9); // south
    expect(headingFromYaw(Math.atan2(-1, 0))).toBeCloseTo(270, 9); // west
    // on-map ground speed in m per wall-clock second: real-world speed × timeScale
    expect(realSpeedMps(playbackSpeeds(8, 1).walk, 8)).toBeCloseTo(4.8 / 3.6, 9);
    expect(realSpeedMps(playbackSpeeds(8, 20).walk, 8)).toBeCloseTo((4.8 / 3.6) * 20, 9);
    expect(realSpeedMps(playbackSpeeds(8, 1).plane / 2, 8)).toBeCloseTo(90 / 3.6, 9);
    expect(realSpeedMps(playbackSpeeds(2, 5).car, 2)).toBeCloseTo((30 / 3.6) * 5, 9);
    expect(realSpeedMps(0, 8)).toBe(0);
  });
});

describe('animation cadence', () => {
  it('follows the on-screen speed relative to the character size', () => {
    expect(walkCadence(WALK_CADENCE_SPEED)).toBeCloseTo(1, 12);
    expect(walkCadence(WALK_CADENCE_SPEED, 2)).toBeCloseTo(0.5, 12);
    // ×20 real walking is about the natural cadence
    const fastWalk = playbackSpeeds(8, 20).walk;
    expect(clipTimeScale('walk', walkCadence(fastWalk))).toBeCloseTo(fastWalk / WALK_CADENCE_SPEED, 12);
    expect(clipTimeScale('run', walkCadence(WALK_CADENCE_SPEED * 3))).toBeCloseTo(1.5, 12);
    expect(clipTimeScale('walk', 10)).toBe(2.2);
  });

  it('keeps a minimum cadence at real-world speed and still walks (not idle)', () => {
    const real = playbackSpeeds(8, 1).walk;
    expect(clipTimeScale('walk', walkCadence(real))).toBe(MIN_CADENCE);
    const all = { idle: 'i', walk: 'w', run: 'r' };
    expect(chooseAnimation('walk', real, all)).toBe('walk');
    // a real-time walk on a coarse world (50 m per unit) is not mistaken for standing
    expect(chooseAnimation('walk', playbackSpeeds(50, 1).walk, all)).toBe('walk');
    expect(chooseAnimation('walk', playbackSpeeds(8, 20).walk, all)).toBe('walk');
  });

  it('chooses run relative to the character size', () => {
    const all = { idle: 'i', walk: 'w', run: 'r' };
    expect(chooseAnimation('walk', WALK_CADENCE_SPEED * 2, all)).toBe('run');
    expect(chooseAnimation('walk', WALK_CADENCE_SPEED * 2, all, 2)).toBe('walk');
  });
});

describe('name tag anchor', () => {
  it('sits above the head when walking or cycling, lower over a car, and scales with the character', () => {
    expect(nameTagAnchor('walk', 1.2)).toEqual({ dx: 0, dy: 2.3, dz: 0 });
    expect(nameTagAnchor('bike', 1.2)).toEqual({ dx: 0, dy: 2.3, dz: 0 });
    expect(nameTagAnchor('car', 1.2)).toEqual({ dx: 0, dy: 2.0, dz: 0 });
    expect(nameTagAnchor('walk', 0, 2)).toEqual({ dx: 0, dy: 4.6, dz: 0 });
  });

  it('follows the middle car of the subway train behind the character', () => {
    const south = nameTagAnchor('subway', 0); // facing +z: cars trail towards −z
    expect(south.dx).toBeCloseTo(0, 9);
    expect(south.dz).toBeCloseTo(-2.2, 9);
    expect(south.dy).toBeCloseTo(1.25, 9);
    const east = nameTagAnchor('subway', Math.PI / 2); // facing +x
    expect(east.dx).toBeCloseTo(-2.2, 9);
    expect(east.dz).toBeCloseTo(0, 9);
    // before the train has popped in, the tag stays on the character
    expect(nameTagAnchor('subway', 0, 1, 0)).toEqual({ dx: 0, dy: 2.3, dz: 0 });
  });

  it('sits just above the plane while flying', () => {
    // the plane's real geometry: its highest point is the tail fin at PLANE_TOP_Y
    const root = new Group();
    const part: PartFn = (parent, geo, mat, x, y, z) => {
      const g = new Group();
      g.position.set(x, y, z);
      g.add(new Mesh(geo, mat));
      parent.add(g);
      return g;
    };
    const m = new MeshBasicMaterial();
    const set = buildVehicles(root, part, { make: () => new MeshBasicMaterial() } as unknown as MaterialFactory, { skin: m, tire: m, chrome: m, glassDark: m }, []);
    set.plane.group.scale.setScalar(1);
    root.updateMatrixWorld(true);
    expect(new Box3().setFromObject(set.plane.group).max.y).toBeCloseTo(PLANE_TOP_Y, 6);

    const top = PLANE_TOP_Y * PLANE_SCALE;
    const a = nameTagAnchor('plane', 1.2);
    expect(a.dx).toBe(0);
    expect(a.dz).toBe(0);
    expect(a.dy).toBeGreaterThan(top);
    expect(a.dy).toBeLessThan(top + 0.5);
    expect(a.dy).toBeLessThan(nameTagAnchor('walk', 1.2).dy);
    expect(nameTagAnchor('plane', 0, 2).dy).toBeCloseTo(2 * a.dy, 9);
    // before the plane has popped in, the tag stays above the character's head
    expect(nameTagAnchor('plane', 0, 1, 0)).toEqual({ dx: 0, dy: 2.3, dz: 0 });
  });
});

describe('GLB fixture (dev/fixtures/box-character.glb)', () => {
  const load = (): Promise<GLTF> => {
    const bytes = readFileSync(fileURLToPath(new URL('../../dev/fixtures/box-character.glb', import.meta.url)));
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Promise((resolve, reject) => new GLTFLoader().parse(data, '', resolve, reject));
  };

  it('loads a real GLB: idle / walk clips resolve, the model normalizes to the character height and animates', async () => {
    const gltf = await load();
    const names = gltf.animations.map((c) => c.name);
    expect([...names].sort()).toEqual(['idle', 'walk']);
    const clips = resolveClips(names);
    expect(clips).toEqual({ idle: 'idle', walk: 'walk' });
    expect(chooseAnimation('walk', 0, clips)).toBe('idle');
    expect(chooseAnimation('walk', WALK_CADENCE_SPEED, clips)).toBe('walk');

    const wrap = normalizeModel(instantiateModel(gltf), CHARACTER_HEIGHT);
    wrap.updateMatrixWorld(true);
    const box = new Box3().setFromObject(wrap);
    expect(box.getSize(new Vector3()).y).toBeCloseTo(CHARACTER_HEIGHT, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    let meshes = 0;
    wrap.traverse((o) => { if ((o as Mesh).isMesh) { meshes++; expect(o.userData.model).toBe(true); } });
    expect(meshes).toBe(2);

    const body = wrap.getObjectByName('body') as Object3D;
    const mixer = new AnimationMixer(wrap);
    mixer.clipAction(gltf.animations.find((c) => c.name === 'walk')!).play();
    mixer.update(0.15);
    expect(body.rotation.z).toBeCloseTo(0.12, 3);
  });
});
