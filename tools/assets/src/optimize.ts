/**
 * `maprama optimize`: dedup, prune, weld, resample, simplify to a triangle
 * budget, resize textures, normalize origin/facing/height, and compress.
 *
 * @module
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Document, type vec4 } from '@gltf-transform/core';
import { compressTexture, dedup, draco, meshopt, prune, resample, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { countTriangles, inspectDocument, sceneBounds, type InspectReport } from './inspect.js';
import { getIO } from './io.js';

/** The direction the source model faces; it is rotated about +Y to face +Z. */
export type Facing = '+z' | '-z' | '+x' | '-x';
export const FACINGS: readonly Facing[] = ['+z', '-z', '+x', '-x'];

export type Compression = 'none' | 'draco' | 'meshopt';

export interface OptimizeOptions {
  /** Triangle budget for the whole scene. Default 20 000. */
  maxTriangles?: number;
  /** Maximum texture width/height in pixels. Default 1024. */
  maxTexture?: number;
  /** Geometry compression. Default `none`. */
  compression?: Compression;
  /** Move the origin to the bottom-center of the bounds (feet). */
  centerFeet?: boolean;
  /** Direction the source model faces; rotated so it faces +Z (engine forward). */
  face?: Facing;
  /** Uniformly scale so the model is this tall (meters). */
  scaleToHeight?: number;
  log?: (message: string) => void;
}

export interface OptimizeResult {
  steps: string[];
  warnings: string[];
}

export interface OptimizeReport extends OptimizeResult {
  input: string;
  output: string;
  before: InspectReport;
  after: InspectReport;
  /** Suggested `CharacterSpec.animations` when clip names are not conventional. */
  suggestedAnimations?: InspectReport['clips']['suggestedMapping'];
}

/** Yaw (radians about +Y) that turns `face` into +Z. */
export function yawForFacing(face: Facing): number {
  switch (face) {
    case '+z':
      return 0;
    case '-z':
      return Math.PI;
    case '+x':
      return -Math.PI / 2;
    case '-x':
      return Math.PI / 2;
  }
}

/**
 * Wraps the scene's root nodes in a `maprama_root` node carrying the facing
 * rotation, height scale and feet-centering translation. Using a wrapper keeps
 * skins and animations intact.
 */
function normalize(doc: Document, options: OptimizeOptions, steps: string[], warnings: string[]): void {
  const { face, scaleToHeight, centerFeet } = options;
  const needsFace = face !== undefined && face !== '+z';
  if (!needsFace && scaleToHeight === undefined && !centerFeet) return;
  const docRoot = doc.getRoot();
  const scene = docRoot.getDefaultScene() ?? docRoot.listScenes()[0];
  if (!scene) {
    warnings.push('no scene: skipped normalization');
    return;
  }
  const wrapper = doc.createNode('maprama_root');
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrapper.addChild(child);
  }
  scene.addChild(wrapper);

  if (needsFace) {
    const half = yawForFacing(face) / 2;
    wrapper.setRotation([0, Math.sin(half), 0, Math.cos(half)] as vec4);
    steps.push(`rotate ${face} → +z`);
  }
  if (scaleToHeight !== undefined) {
    const h = sceneBounds(doc).size[1];
    if (h > 0) {
      const s = scaleToHeight / h;
      wrapper.setScale([s, s, s]);
      steps.push(`scale ×${s.toPrecision(4)} (height ${h.toFixed(3)} m → ${scaleToHeight} m)`);
    } else {
      warnings.push('model has zero height: skipped --scale-to-height');
    }
  }
  if (centerFeet) {
    const b = sceneBounds(doc);
    wrapper.setTranslation([-b.center[0], -b.min[1], -b.center[2]]);
    steps.push('origin → feet (bottom center)');
  }
}

/** Optimizes a document in place. */
export async function optimizeDocument(doc: Document, options: OptimizeOptions = {}): Promise<OptimizeResult> {
  const log = options.log ?? (() => {});
  const maxTriangles = options.maxTriangles ?? 20000;
  const maxTexture = options.maxTexture ?? 1024;
  const compression = options.compression ?? 'none';
  const steps: string[] = [];
  const warnings: string[] = [];
  const root = doc.getRoot();

  await doc.transform(dedup(), prune());
  steps.push('dedup', 'prune');
  await doc.transform(weld());
  steps.push('weld');
  if (root.listAnimations().length > 0) {
    await doc.transform(resample());
    steps.push('resample');
  }

  normalize(doc, options, steps, warnings);

  // Triangle budget.
  let tris = countTriangles(doc);
  if (tris > maxTriangles) {
    await MeshoptSimplifier.ready;
    const start = tris;
    for (const error of [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1]) {
      if (tris <= maxTriangles) break;
      const ratio = Math.min(1, (maxTriangles / tris) * 0.95);
      log(`simplify: ${tris} triangles, ratio ${ratio.toFixed(3)}, error ${error}`);
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error }));
      tris = countTriangles(doc);
    }
    steps.push(`simplify ${start} → ${tris} triangles`);
    if (tris > maxTriangles) {
      warnings.push(`could not reach the ${maxTriangles} triangle budget (${tris} left; morph targets or locked topology?)`);
    }
  }

  // Textures.
  for (const texture of root.listTextures()) {
    const size = texture.getSize();
    const label = texture.getName() || texture.getURI() || texture.getMimeType();
    if (!size) {
      warnings.push(`texture "${label}" (${texture.getMimeType()}) size unknown: not resized`);
      continue;
    }
    if (size[0] > maxTexture || size[1] > maxTexture) {
      await compressTexture(texture, { encoder: sharp, resize: [maxTexture, maxTexture] });
      const next = texture.getSize();
      steps.push(`texture "${label}" ${size[0]}x${size[1]} → ${next?.[0]}x${next?.[1]}`);
    }
  }

  await doc.transform(prune(), dedup());

  if (compression === 'draco') {
    await doc.transform(draco({ method: 'edgebreaker' }));
    steps.push('draco');
  } else if (compression === 'meshopt') {
    await MeshoptEncoder.ready;
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    steps.push('meshopt');
  }

  const report = inspectDocument(doc);
  if (root.listAnimations().length > 0 || report.skinned) warnings.push(...report.warnings.filter((w) => /clip|mapping/.test(w)));
  return { steps, warnings };
}

/** Reads `input`, optimizes it and writes `output` (GLB or glTF by extension). */
export async function optimizeFile(input: string, output: string, options: OptimizeOptions = {}): Promise<OptimizeReport> {
  const io = await getIO();
  const doc = await io.read(input);
  const before = { file: input, ...inspectDocument(doc) };
  const result = await optimizeDocument(doc, options);
  await mkdir(dirname(output), { recursive: true });
  await io.write(output, doc);
  const reread = await io.read(output);
  const after = { file: output, ...inspectDocument(reread) };
  const report: OptimizeReport = { input, output, before, after, ...result };
  if (after.clips.mappingNeeded) report.suggestedAnimations = after.clips.suggestedMapping;
  return report;
}
