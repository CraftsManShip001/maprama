#!/usr/bin/env node
/**
 * Generates `src/data/sampleModel.ts`: a tiny CC0 glTF 2.0 character (a boxy
 * robot: bright orange torso, mint cube head with a dark visor and a yellow
 * antenna; feet at the origin, facing +Z, 1.6 m tall) with `idle` and `walk`
 * animation clips, embedded as a `data:` URI string. It is deliberately unlike
 * the engine's default avatar (rounded body, skin-coloured sphere head), so a
 * screenshot shows whether the glTF or the fallback is on screen.
 *
 * Authored here from scratch (no third-party model), so it is CC0 / public
 * domain. A data URI is used because the WebView host runs with
 * `allowFileAccess={false}`, so bundled `require('./x.glb')` files may not load
 * in release builds.
 *
 *   node scripts/make-sample-model.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'data', 'sampleModel.ts');

/** Axis-aligned box: 24 vertices (flat normals) and 36 indices. */
function box(cx, cy, cz, sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
  const pos = [], nor = [], idx = [];
  faces.forEach((f, i) => {
    for (const p of f.v) { pos.push(p[0] + cx, p[1] + cy, p[2] + cz); nor.push(...f.n); }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { pos, nor, idx };
}

const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];

function pushView(typed, target) {
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(bytes);
  const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength };
  if (target) view.target = target;
  bufferViews.push(view);
  byteLength += bytes.byteLength;
  return bufferViews.length - 1;
}

function accessor(typed, type, componentType, extra = {}, target) {
  const view = pushView(typed, target);
  const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  accessors.push({ bufferView: view, componentType, count: typed.length / size, type, ...extra });
  return accessors.length - 1;
}

function minMax(arr, size) {
  const min = Array(size).fill(Infinity), max = Array(size).fill(-Infinity);
  for (let i = 0; i < arr.length; i += size) for (let k = 0; k < size; k++) { min[k] = Math.min(min[k], arr[i + k]); max[k] = Math.max(max[k], arr[i + k]); }
  return { min, max };
}

const materials = [
  { name: 'body', pbrMetallicRoughness: { baseColorFactor: [1.0, 0.42, 0.05, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
  { name: 'head', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.85, 0.72, 1], metallicFactor: 0, roughnessFactor: 0.5 } },
  { name: 'legs', pbrMetallicRoughness: { baseColorFactor: [0.15, 0.15, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'visor', pbrMetallicRoughness: { baseColorFactor: [0.05, 0.05, 0.08, 1], metallicFactor: 0.3, roughnessFactor: 0.3 } },
  { name: 'antenna', pbrMetallicRoughness: { baseColorFactor: [1.0, 0.85, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
];

const meshes = [];
function mesh(name, geom, material) {
  const pos = new Float32Array(geom.pos), nor = new Float32Array(geom.nor), idx = new Uint16Array(geom.idx);
  const mm = minMax(geom.pos, 3);
  const p = accessor(pos, 'VEC3', 5126, mm, 34962);
  const n = accessor(nor, 'VEC3', 5126, {}, 34962);
  const i = accessor(idx, 'SCALAR', 5123, {}, 34963);
  meshes.push({ name, primitives: [{ attributes: { POSITION: p, NORMAL: n }, indices: i, material }] });
  return meshes.length - 1;
}

// Geometry relative to each node's pivot (legs pivot at the hip so they swing).
const torso = mesh('torso', box(0, 0.24, 0, 0.5, 0.48, 0.3), 0);
const head = mesh('head', box(0, 0.15, 0, 0.4, 0.3, 0.36), 1);
const leg = mesh('leg', box(0, -0.31, 0, 0.16, 0.62, 0.18), 2);
const visor = mesh('visor', box(0, 0.16, 0.19, 0.32, 0.1, 0.02), 3);
const stem = mesh('antenna', box(0, 0.06, 0, 0.04, 0.12, 0.04), 4);
const tip = mesh('antenna_tip', box(0, 0.03, 0, 0.07, 0.06, 0.07), 4);

// Node indices 1-4 are the animation targets below; the head's parts ride on node 2.
const nodes = [
  { name: 'diorama_character', children: [1, 2, 3, 4] },
  { name: 'torso', mesh: torso, translation: [0, 0.62, 0] },
  { name: 'head', mesh: head, translation: [0, 1.12, 0], children: [5, 6, 7] },
  { name: 'leg_l', mesh: leg, translation: [-0.11, 0.62, 0] },
  { name: 'leg_r', mesh: leg, translation: [0.11, 0.62, 0] },
  { name: 'visor', mesh: visor },
  { name: 'antenna', mesh: stem, translation: [0, 0.3, 0] },
  { name: 'antenna_tip', mesh: tip, translation: [0, 0.42, 0] },
];

function quatX(deg) {
  const r = (deg * Math.PI) / 180 / 2;
  return [Math.sin(r), 0, 0, Math.cos(r)];
}

const animations = [];
function clip(name, duration, tracks) {
  const samplers = [], channels = [];
  for (const t of tracks) {
    const input = accessor(new Float32Array(t.times), 'SCALAR', 5126, { min: [0], max: [duration] });
    const size = t.path === 'rotation' ? 4 : 3;
    const output = accessor(new Float32Array(t.values.flat()), size === 4 ? 'VEC4' : 'VEC3', 5126);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: t.node, path: t.path } });
  }
  animations.push({ name, samplers, channels });
}

// idle: gentle head bob.
clip('idle', 2, [
  { node: 2, path: 'translation', times: [0, 1, 2], values: [[0, 1.12, 0], [0, 1.15, 0], [0, 1.12, 0]] },
]);
// walk: legs swing in opposition, torso bobs.
clip('walk', 0.8, [
  { node: 3, path: 'rotation', times: [0, 0.4, 0.8], values: [quatX(30), quatX(-30), quatX(30)] },
  { node: 4, path: 'rotation', times: [0, 0.4, 0.8], values: [quatX(-30), quatX(30), quatX(-30)] },
  { node: 1, path: 'translation', times: [0, 0.2, 0.4, 0.6, 0.8], values: [[0, 0.62, 0], [0, 0.65, 0], [0, 0.62, 0], [0, 0.65, 0], [0, 0.62, 0]] },
]);

const bin = new Uint8Array(byteLength);
let off = 0;
for (const c of chunks) { bin.set(c, off); off += c.byteLength; }

const gltf = {
  asset: { version: '2.0', generator: 'diorama example make-sample-model.mjs', copyright: 'CC0 1.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes,
  meshes,
  materials,
  accessors,
  bufferViews,
  animations,
  buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` }],
};

const uri = `data:model/gltf+json;base64,${Buffer.from(JSON.stringify(gltf)).toString('base64')}`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `/**\n * GENERATED by scripts/make-sample-model.mjs. Do not edit.\n *\n * A tiny CC0 glTF 2.0 robot (orange torso, mint cube head, dark visor, yellow\n * antenna; feet at origin, faces +Z, 1.6 m) with \`idle\` and \`walk\` clips,\n * embedded as a data: URI (${uri.length} chars).\n */\nexport const SAMPLE_CHARACTER_MODEL_URI =\n  '${uri}';\n`,
);
console.log(`wrote ${out} (${uri.length} chars)`);
