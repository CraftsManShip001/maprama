import { afterAll, describe, expect, it } from 'vitest';
import { analyzeClips, inspectDocument, inspectFile } from '../src/inspect.js';
import { makeModel, tempDir, writeModel } from './helpers.js';

const tmp = tempDir();
afterAll(tmp.cleanup);

describe('analyzeClips', () => {
  it('suggests a mapping for non-conventional clip names', () => {
    const r = analyzeClips(['Armature|Walking', 'idle', 'Run_Fast', 'Dance']);
    expect(r.found).toEqual(['idle']);
    expect(r.suggestedMapping).toEqual({ walk: 'Armature|Walking', run: 'Run_Fast' });
    expect(r.missing).toEqual(['ride', 'wave']);
    expect(r.unmatched).toEqual(['Dance']);
    expect(r.mappingNeeded).toBe(true);
  });

  it('needs no mapping when every clip is conventional', () => {
    const r = analyzeClips(['idle', 'walk', 'run', 'ride', 'wave']);
    expect(r.mappingNeeded).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.suggestedMapping).toEqual({});
  });

  it('recognises common synonyms', () => {
    const r = analyzeClips(['mixamo.com|Standing Idle', 'Jog', 'Bicycle', 'Hello']);
    expect(r.suggestedMapping).toEqual({ idle: 'mixamo.com|Standing Idle', run: 'Jog', ride: 'Bicycle', wave: 'Hello' });
  });
});

describe('inspectFile', () => {
  it('reports bounds, triangles, textures, clips and skinning', async () => {
    const path = await writeModel(tmp.dir, 'box.glb', {
      min: [2, 5, -1],
      max: [3, 7, 0],
      texture: [64, 32],
      animations: ['Armature|Walking'],
    });
    const r = await inspectFile(path);
    expect(r.fileBytes).toBeGreaterThan(0);
    expect(r.triangles).toBe(12);
    expect(r.bounds.min).toEqual([2, 5, -1]);
    expect(r.bounds.size).toEqual([1, 2, 1]);
    expect(r.bounds.units).toBe('meters');
    expect(r.axes.up).toBe('+y');
    expect(r.textures).toEqual([expect.objectContaining({ width: 64, height: 32, mimeType: 'image/png' })]);
    expect(r.animations.map((a) => a.name)).toEqual(['Armature|Walking']);
    expect(r.animations[0]!.duration).toBeCloseTo(1);
    expect(r.clips.mappingNeeded).toBe(true);
    expect(r.clips.suggestedMapping).toEqual({ walk: 'Armature|Walking' });
    expect(r.skinned).toBe(false);
    expect(r.warnings.some((w) => w.includes('"Armature|Walking" does not match'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('origin is not at the feet'))).toBe(true);
  });
});

describe('inspectDocument', () => {
  it('detects skins', async () => {
    const { doc, node } = await makeModel();
    const joint = doc.createNode('hips');
    doc.getRoot().listScenes()[0]!.addChild(joint);
    node.setSkin(doc.createSkin('skin').addJoint(joint));
    const r = inspectDocument(doc);
    expect(r.skinned).toBe(true);
    expect(r.joints).toBe(1);
  });

  it('guesses Z-up for a model that is tallest along Z', async () => {
    const { doc } = await makeModel({ min: [0, 0, 0], max: [0.5, 0.5, 2] });
    expect(inspectDocument(doc).axes.up).toBe('+z');
  });
});
