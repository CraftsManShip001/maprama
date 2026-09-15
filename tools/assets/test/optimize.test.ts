import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { optimizeFile, yawForFacing } from '../src/optimize.js';
import { tempDir, writeModel } from './helpers.js';

const tmp = tempDir();
afterAll(tmp.cleanup);
const out = (name: string): string => join(tmp.dir, name);

describe('optimize', () => {
  it('simplifies to the triangle budget', async () => {
    const input = await writeModel(tmp.dir, 'sphere.glb', { sphere: 64 });
    const r = await optimizeFile(input, out('sphere.opt.glb'), { maxTriangles: 500 });
    expect(r.before.triangles).toBe(3968);
    expect(r.after.triangles).toBeGreaterThan(0);
    expect(r.after.triangles).toBeLessThanOrEqual(500);
    expect(r.steps.some((s) => s.startsWith('simplify'))).toBe(true);
  });

  it('leaves models under budget alone', async () => {
    const input = await writeModel(tmp.dir, 'small.glb');
    const r = await optimizeFile(input, out('small.opt.glb'));
    expect(r.after.triangles).toBe(12);
    expect(r.steps.some((s) => s.startsWith('simplify'))).toBe(false);
  });

  it('moves the origin to the feet', async () => {
    const input = await writeModel(tmp.dir, 'offset.glb', { min: [2, 5, -1], max: [3, 7, 0] });
    const r = await optimizeFile(input, out('offset.opt.glb'), { centerFeet: true });
    expect(r.after.bounds.min[1]).toBeCloseTo(0, 5);
    expect(r.after.bounds.center[0]).toBeCloseTo(0, 5);
    expect(r.after.bounds.center[2]).toBeCloseTo(0, 5);
    expect(r.after.bounds.size[1]).toBeCloseTo(2, 5);
    expect(r.after.warnings.some((w) => w.includes('origin is not at the feet'))).toBe(false);
  });

  it('scales to a target height', async () => {
    const input = await writeModel(tmp.dir, 'tall.glb', { min: [0, 0, 0], max: [0.5, 180, 0.3] });
    const r = await optimizeFile(input, out('tall.opt.glb'), { scaleToHeight: 1.8, centerFeet: true });
    expect(r.after.bounds.size[1]).toBeCloseTo(1.8, 4);
    expect(r.after.bounds.min[1]).toBeCloseTo(0, 4);
  });

  it('rotates a +X-facing model to face +Z', async () => {
    expect(yawForFacing('+z')).toBe(0);
    // A box lying entirely on the +X side ends up on the +Z side.
    const input = await writeModel(tmp.dir, 'facing.glb', { min: [1, 0, -0.1], max: [2, 1, 0.1] });
    const r = await optimizeFile(input, out('facing.opt.glb'), { face: '+x' });
    expect(r.after.bounds.min[2]).toBeCloseTo(1, 4);
    expect(r.after.bounds.max[2]).toBeCloseTo(2, 4);
    expect(r.after.bounds.size[0]).toBeCloseTo(0.2, 4);
  });

  it('warns about non-conventional clip names and suggests a mapping', async () => {
    const input = await writeModel(tmp.dir, 'anim.glb', { animations: ['Armature|Walking', 'idle'] });
    const r = await optimizeFile(input, out('anim.opt.glb'));
    expect(r.after.animations.map((a) => a.name).sort()).toEqual(['Armature|Walking', 'idle']);
    expect(r.warnings.some((w) => w.includes('"Armature|Walking" does not match idle|walk|run|ride|wave'))).toBe(true);
    expect(r.suggestedAnimations).toEqual({ walk: 'Armature|Walking' });
  });

  it('does not warn when clip names are conventional', async () => {
    const input = await writeModel(tmp.dir, 'anim2.glb', { animations: ['idle', 'walk'] });
    const r = await optimizeFile(input, out('anim2.opt.glb'));
    expect(r.warnings.filter((w) => /clip|mapping/.test(w))).toEqual([]);
    expect(r.suggestedAnimations).toBeUndefined();
  });

  it('resizes oversized textures', async () => {
    const input = await writeModel(tmp.dir, 'tex.glb', { texture: [64, 32] });
    const r = await optimizeFile(input, out('tex.opt.glb'), { maxTexture: 16 });
    expect(r.after.textures).toEqual([expect.objectContaining({ width: 16, height: 8 })]);
  });

  it('applies Draco compression', async () => {
    const input = await writeModel(tmp.dir, 'draco.glb');
    const r = await optimizeFile(input, out('draco.opt.glb'), { compression: 'draco' });
    expect(r.after.extensionsUsed).toContain('KHR_draco_mesh_compression');
    expect(r.after.triangles).toBe(12);
  });

  it('applies Meshopt compression', async () => {
    const input = await writeModel(tmp.dir, 'meshopt.glb', { animations: ['walk'] });
    const r = await optimizeFile(input, out('meshopt.opt.glb'), { compression: 'meshopt' });
    expect(r.after.extensionsUsed).toContain('EXT_meshopt_compression');
    expect(r.after.triangles).toBe(12);
    expect(r.after.animations.map((a) => a.name)).toEqual(['walk']);
  });
});
