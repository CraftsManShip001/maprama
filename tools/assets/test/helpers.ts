import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, type Buffer as GltfBuffer, type Node, type vec3 } from '@gltf-transform/core';
import sharp from 'sharp';
import { getIO } from '../src/io.js';

export interface TestModelOptions {
  /** Box bounds (default unit box at the origin). Ignored when `sphere` is set. */
  min?: vec3;
  max?: vec3;
  /** Use a UV sphere with this many width segments (height = width / 2). */
  sphere?: number;
  /** Animation clip names (translation channels on the mesh node). */
  animations?: string[];
  /** Base color texture size [w, h]. */
  texture?: [number, number];
}

interface Geometry {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
}

function boxGeometry(min: vec3, max: vec3): Geometry {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ]);
  return { positions, indices };
}

function sphereGeometry(segW: number): Geometry {
  const segH = Math.floor(segW / 2);
  const pos: number[] = [];
  const idx: number[] = [];
  for (let iy = 0; iy <= segH; iy++) {
    for (let ix = 0; ix <= segW; ix++) {
      const theta = (ix / segW) * Math.PI * 2;
      const phi = (iy / segH) * Math.PI;
      pos.push(-0.5 * Math.cos(theta) * Math.sin(phi), 0.5 * Math.cos(phi) + 0.5, 0.5 * Math.sin(theta) * Math.sin(phi));
    }
  }
  for (let iy = 0; iy < segH; iy++) {
    for (let ix = 0; ix < segW; ix++) {
      const a = iy * (segW + 1) + ix + 1;
      const b = iy * (segW + 1) + ix;
      const c = (iy + 1) * (segW + 1) + ix;
      const d = (iy + 1) * (segW + 1) + ix + 1;
      if (iy !== 0) idx.push(a, b, d);
      if (iy !== segH - 1) idx.push(b, c, d);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Builds a tiny glTF document programmatically. */
export async function makeModel(options: TestModelOptions = {}): Promise<{ doc: Document; node: Node }> {
  const doc = new Document();
  const buffer: GltfBuffer = doc.createBuffer();
  const geo = options.sphere ? sphereGeometry(options.sphere) : boxGeometry(options.min ?? [0, 0, 0], options.max ?? [1, 1, 1]);
  const position = doc.createAccessor('position').setType('VEC3').setArray(geo.positions).setBuffer(buffer);
  const indices = doc.createAccessor('indices').setType('SCALAR').setArray(geo.indices).setBuffer(buffer);
  const material = doc.createMaterial('mat');
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices).setMaterial(material);
  if (options.texture) {
    const [w, h] = options.texture;
    // A gradient: solid-color textures would be folded into material factors by prune().
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        pixels[i] = (x * 255) / Math.max(1, w - 1);
        pixels[i + 1] = (y * 255) / Math.max(1, h - 1);
        pixels[i + 2] = 128;
        pixels[i + 3] = 255;
      }
    }
    const png = await sharp(pixels, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    const texture = doc.createTexture('base').setImage(new Uint8Array(png)).setMimeType('image/png');
    material.setBaseColorTexture(texture);
    const uvCount = geo.positions.length / 3;
    const uv = doc.createAccessor('uv').setType('VEC2').setArray(new Float32Array(uvCount * 2)).setBuffer(buffer);
    prim.setAttribute('TEXCOORD_0', uv);
  }
  const mesh = doc.createMesh('mesh').addPrimitive(prim);
  const node = doc.createNode('model').setMesh(mesh);
  doc.createScene('scene').addChild(node);
  doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]!);

  for (const name of options.animations ?? []) {
    const times = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 0.5, 1])).setBuffer(buffer);
    const values = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 0, 0.1, 0, 0, 0, 0]))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(times).setOutput(values).setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel().setTargetNode(node).setTargetPath('translation').setSampler(sampler);
    doc.createAnimation(name).addSampler(sampler).addChannel(channel);
  }
  return { doc, node };
}

/** Temporary directory helper. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'maprama-assets-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a model to `<dir>/<name>` and returns the path. */
export async function writeModel(dir: string, name: string, options: TestModelOptions = {}): Promise<string> {
  const { doc } = await makeModel(options);
  const path = join(dir, name);
  await (await getIO()).write(path, doc);
  return path;
}
