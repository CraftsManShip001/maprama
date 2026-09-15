/**
 * `maprama inspect`: a JSON report about a glTF/GLB model — bounds, axis
 * guesses, triangle count, textures, animation clips and skinning.
 *
 * @module
 */

import { stat } from 'node:fs/promises';
import { Primitive, getBounds, type Document, type Scene, type vec3 } from '@gltf-transform/core';
import { ANIMATION_NAMES, type AnimationName } from '@maprama/protocol';
import { getIO } from './io.js';

/** Axis label. `±` means the sign could not be inferred. */
export type AxisGuess = '+x' | '-x' | '+y' | '-y' | '+z' | '-z' | '±x' | '±z';

/** Animation clip analysis against the conventional names `idle|walk|run|ride|wave`. */
export interface ClipReport {
  required: AnimationName[];
  /** Conventional names present exactly. */
  found: AnimationName[];
  /** Conventional names absent (neither exact nor suggested). */
  missing: AnimationName[];
  /** True when at least one conventional name needs a `CharacterSpec.animations` mapping. */
  mappingNeeded: boolean;
  /** Suggested `CharacterSpec.animations` object (conventional name → clip name in the model). */
  suggestedMapping: Partial<Record<AnimationName, string>>;
  /** Clip names that are neither conventional nor used by the suggestion. */
  unmatched: string[];
}

export interface TextureReport {
  name: string;
  uri: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface InspectReport {
  file?: string;
  fileBytes?: number;
  generator: string;
  bounds: { min: vec3; max: vec3; size: vec3; center: vec3; units: 'meters' };
  axes: { up: AxisGuess; forward: AxisGuess; confidence: 'low' | 'medium'; notes: string[] };
  triangles: number;
  vertices: number;
  meshes: number;
  primitives: number;
  materials: number;
  nodes: number;
  skinned: boolean;
  skins: number;
  joints: number;
  morphTargets: boolean;
  textures: TextureReport[];
  animations: { name: string; duration: number; channels: number }[];
  clips: ClipReport;
  extensionsUsed: string[];
  warnings: string[];
}

const CLIP_PATTERNS: Record<AnimationName, RegExp> = {
  idle: /idle|standing|stand\b|breath/i,
  walk: /walk/i,
  run: /run|jog|sprint/i,
  ride: /ride|riding|bike|bicycle|cycl|drive|driving|sitting/i,
  wave: /wave|waving|hello|greet/i,
};

/** Last path segment of a clip name (`"Armature|mixamo.com|Walk"` → `"Walk"`). */
function clipLeaf(name: string): string {
  const parts = name.split(/[|/:]/).filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/** Matches clip names to conventional animation names. */
export function analyzeClips(names: string[]): ClipReport {
  const required = [...ANIMATION_NAMES];
  const found = required.filter((n) => names.includes(n));
  const used = new Set<string>(found);
  const suggestedMapping: Partial<Record<AnimationName, string>> = {};
  for (const anim of required) {
    if (found.includes(anim)) continue;
    const pattern = CLIP_PATTERNS[anim];
    const candidates = names
      .filter((n) => !used.has(n) && !(ANIMATION_NAMES as readonly string[]).includes(n))
      .filter((n) => pattern.test(clipLeaf(n)) || clipLeaf(n).toLowerCase() === anim)
      .sort((a, b) => clipLeaf(a).length - clipLeaf(b).length || a.localeCompare(b));
    const pick = candidates[0];
    if (pick !== undefined) {
      suggestedMapping[anim] = pick;
      used.add(pick);
    }
  }
  const missing = required.filter((n) => !found.includes(n) && suggestedMapping[n] === undefined);
  return {
    required,
    found,
    missing,
    mappingNeeded: Object.keys(suggestedMapping).length > 0,
    suggestedMapping,
    unmatched: names.filter((n) => !used.has(n)),
  };
}

/** Warnings for clip names that do not follow the convention. */
export function clipWarnings(clips: ClipReport, animationNames: string[]): string[] {
  const warnings: string[] = [];
  const conventional = ANIMATION_NAMES as readonly string[];
  for (const name of animationNames) {
    if (!conventional.includes(name)) {
      warnings.push(`animation clip "${name}" does not match ${ANIMATION_NAMES.join('|')}`);
    }
  }
  if (clips.mappingNeeded) {
    warnings.push(`suggested CharacterSpec.animations mapping: ${JSON.stringify(clips.suggestedMapping)}`);
  }
  return warnings;
}

function defaultScene(doc: Document): Scene | undefined {
  const root = doc.getRoot();
  return root.getDefaultScene() ?? root.listScenes()[0];
}

function trianglesOf(prim: Primitive): number {
  const count = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
  switch (prim.getMode()) {
    case Primitive.Mode.TRIANGLES:
      return Math.floor(count / 3);
    case Primitive.Mode.TRIANGLE_STRIP:
    case Primitive.Mode.TRIANGLE_FAN:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

/** Rendered triangles in the default scene (instanced meshes counted per node). */
export function countTriangles(doc: Document): number {
  const scene = defaultScene(doc);
  let total = 0;
  scene?.traverse((node) => {
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) total += trianglesOf(prim);
  });
  return total;
}

/** World-space bounds of the default scene (zeros when there is no geometry). */
export function sceneBounds(doc: Document): { min: vec3; max: vec3; size: vec3; center: vec3 } {
  const scene = defaultScene(doc);
  const b = scene ? getBounds(scene) : { min: [Infinity, Infinity, Infinity] as vec3, max: [-Infinity, -Infinity, -Infinity] as vec3 };
  if (!b.min.every(Number.isFinite)) {
    const zero: vec3 = [0, 0, 0];
    return { min: zero, max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  }
  const size: vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const center: vec3 = [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];
  return { min: b.min, max: b.max, size, center };
}

function guessAxes(size: vec3, skinned: boolean): InspectReport['axes'] {
  const [sx, sy, sz] = size;
  const notes: string[] = [];
  let up: AxisGuess = '+y';
  let forward: AxisGuess = '+z';
  let confidence: 'low' | 'medium' = 'low';
  if (sx === 0 && sy === 0 && sz === 0) return { up, forward, confidence, notes: ['no geometry'] };

  if (sz > sy * 1.5 && sz >= sx) {
    up = '+z';
    notes.push('tallest extent is Z: the model may be Z-up (glTF expects +Y up); re-export with Y-up');
  } else if (sy >= sx && sy >= sz) {
    confidence = 'medium';
    notes.push('tallest extent is Y (glTF +Y up)');
  } else {
    notes.push('glTF convention assumed (+Y up)');
  }

  const horizontal = up === '+z' ? [sx, sy] : [sx, sz];
  const [wide, deep] = horizontal as [number, number];
  if (skinned) {
    // Characters are usually wider (shoulders/arms) than deep: depth axis = facing axis.
    if (deep > wide * 1.2) {
      forward = '±x';
      notes.push('character is deeper along Z than X: it may face ±X; pass --face to rotate it to +Z');
    } else {
      notes.push('character width is along X: assuming it faces +Z (glTF convention); sign cannot be inferred');
    }
  } else if (wide > deep * 1.5) {
    forward = '±x';
    notes.push('longest horizontal extent is X: vehicles usually face along their long axis (±X)');
  } else {
    notes.push('assuming +Z forward (glTF convention); sign cannot be inferred from bounds');
  }
  return { up, forward, confidence, notes };
}

/** Inspects an in-memory document. */
export function inspectDocument(doc: Document): InspectReport {
  const root = doc.getRoot();
  const warnings: string[] = [];
  const bounds = sceneBounds(doc);

  const meshes = root.listMeshes();
  let primitives = 0;
  let vertices = 0;
  let morphTargets = false;
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      primitives++;
      vertices += prim.getAttribute('POSITION')?.getCount() ?? 0;
      if (prim.listTargets().length > 0) morphTargets = true;
    }
  }
  const skins = root.listSkins();
  const skinned = skins.length > 0;

  const textures: TextureReport[] = root.listTextures().map((t) => {
    const size = t.getSize();
    return {
      name: t.getName(),
      uri: t.getURI(),
      mimeType: t.getMimeType(),
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
      bytes: t.getImage()?.byteLength ?? 0,
    };
  });

  const animations = root.listAnimations().map((a) => {
    let duration = 0;
    for (const s of a.listSamplers()) {
      const input = s.getInput();
      if (input && input.getCount() > 0) duration = Math.max(duration, input.getMax([])[0] ?? 0);
    }
    return { name: a.getName(), duration, channels: a.listChannels().length };
  });
  const names = animations.map((a) => a.name);
  const clips = analyzeClips(names);
  if (skinned || animations.length > 0) warnings.push(...clipWarnings(clips, names));
  if (animations.some((a) => a.name === '')) warnings.push('an animation clip has no name');

  const axes = guessAxes(bounds.size, skinned);
  if (axes.up === '+z') warnings.push('model looks Z-up; Maprama engines expect +Y up');
  if (bounds.size[1] > 0 && Math.abs(bounds.min[1]) > bounds.size[1] * 0.05) {
    warnings.push(`origin is not at the feet (min.y = ${bounds.min[1].toFixed(3)} m); use --center-feet`);
  }
  const maxDim = Math.max(...bounds.size);
  if (maxDim > 1000) warnings.push(`model is ${maxDim.toFixed(0)} m across: it may be in centimeters; use --scale-to-height`);

  return {
    generator: root.getAsset().generator ?? '',
    bounds: { ...bounds, units: 'meters' },
    axes,
    triangles: countTriangles(doc),
    vertices,
    meshes: meshes.length,
    primitives,
    materials: root.listMaterials().length,
    nodes: root.listNodes().length,
    skinned,
    skins: skins.length,
    joints: skins.reduce((n, s) => n + s.listJoints().length, 0),
    morphTargets,
    textures,
    animations,
    clips,
    extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName),
    warnings,
  };
}

/** Reads and inspects a glTF/GLB file. */
export async function inspectFile(path: string): Promise<InspectReport> {
  const io = await getIO();
  const doc = await io.read(path);
  const report = inspectDocument(doc);
  return { file: path, fileBytes: (await stat(path)).size, ...report };
}
