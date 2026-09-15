import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, Box3, Vector3, type Mesh, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_HEIGHT,
  chooseAnimation,
  clipTimeScale,
  headingFromYaw,
  instantiateModel,
  MIN_CADENCE,
  nameTagAnchor,
  normalizeModel,
  realSpeedMps,
  resolveClips,
  WALK_CADENCE_SPEED,
  walkCadence,
} from './characters.js';
import { playbackSpeeds } from './follower.js';

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
