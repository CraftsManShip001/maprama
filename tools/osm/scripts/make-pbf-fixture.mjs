// Cuts a small .osm.pbf fixture out of a large one (a Geofabrik extract), so
// the PBF↔Overpass parity test can run offline on committed data.
//
//   node scripts/make-pbf-fixture.mjs <in.osm.pbf> <south,west,north,east> <out.osm.pbf>
//
// The slice is geographic, not tag-filtered: every node inside the bbox, every
// way with a node inside it, every relation with a member that touches it, and
// all the nodes and member ways those need (including the ones outside the
// bbox). Running the reader on the slice therefore sees exactly what it would
// see on the full extract.
//
// This is a development tool: it is not part of the published package, and it
// writes uncompressed-geometry blocks (nodes, then ways, then relations, one
// PrimitiveBlock each) rather than trying to match any writer's layout.
import { createReadStream, writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import Pbf from 'pbf';
import { OSMTransform, parse } from 'osm-pbf-parser-node';
import { Blob as BlobData, BlobHeader } from 'osm-pbf-parser-node/proto/fileformat.js';
import { HeaderBlock, PrimitiveBlock } from 'osm-pbf-parser-node/proto/osmformat.js';

const [input, bboxText, output] = process.argv.slice(2);
if (!input || !bboxText || !output) {
  console.error('usage: make-pbf-fixture.mjs <in.osm.pbf> <south,west,north,east> <out.osm.pbf>');
  process.exit(2);
}
const [south, west, north, east] = bboxText.split(',').map(Number);

async function scan(onBatch) {
  const source = createReadStream(input);
  let stopped = false;
  const sink = new Writable({
    objectMode: true,
    write(chunk, _enc, next) {
      if (!Buffer.isBuffer(chunk)) return next();
      if (onBatch(parse(inflateSync(chunk), { withTags: true, withInfo: false })) === 'stop') {
        stopped = true;
        source.destroy();
      }
      next();
    },
  });
  try {
    await pipeline(source, new OSMTransform({ writeRaw: true }), sink);
  } catch (e) {
    if (!stopped) throw e;
  }
}

const inBBox = (lat, lon) => lat >= south && lat <= north && lon >= west && lon <= east;

/** How far outside the bbox node coordinates are kept, to spot crossing ways. */
const PAD = 0.005;
const inPad = (lat, lon) =>
  lat >= south - PAD && lat <= north + PAD && lon >= west - PAD && lon <= east + PAD;

/** True when the polyline has a vertex in the bbox or a segment across it. */
function reachesBBox(points) {
  for (const [lat, lon] of points) if (inBBox(lat, lon)) return true;
  for (let i = 0; i + 1 < points.length; i++) {
    // Liang–Barsky, on (lon, lat)
    const [aLat, aLon] = points[i], [bLat, bLon] = points[i + 1];
    const dx = bLon - aLon, dy = bLat - aLat;
    const p = [-dx, dx, -dy, dy];
    const q = [aLon - west, east - aLon, aLat - south, north - aLat];
    let t0 = 0, t1 = 1, visible = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) { visible = false; break; }
      } else {
        const r = q[k] / p[k];
        if (p[k] < 0) { if (r > t1) { visible = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { visible = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (visible && t0 <= t1) return true;
  }
  return false;
}

// Pass 1: node coordinates near the bbox, ways reaching it, relations touching
// those. The way test is exact (not "has a node inside"), because the reader
// under test picks up crossing ways and the slice has to contain them.
const padNodes = new Map(); // id -> [lat, lon], within PAD of the bbox
const keptNodeIds = new Set();
const ways = new Map(); // id -> {id, refs, tags}
const relations = new Map();
await scan((items) => {
  for (const el of items) {
    if (el.type === 'node') {
      if (inPad(el.lat, el.lon)) padNodes.set(el.id, [el.lat, el.lon]);
      if (inBBox(el.lat, el.lon)) keptNodeIds.add(el.id);
    } else if (el.type === 'way') {
      const refs = el.refs ?? [];
      const known = refs.map((r) => padNodes.get(r)).filter(Boolean);
      if (known.length === 0 || !reachesBBox(known)) continue;
      ways.set(el.id, { id: el.id, refs, tags: el.tags ?? {} });
      for (const r of refs) keptNodeIds.add(r);
    } else if (el.type === 'relation') {
      const touches = (el.members ?? []).some(
        (m) => (m.type === 'way' && ways.has(m.ref)) || (m.type === 'node' && keptNodeIds.has(m.ref)),
      );
      if (touches) relations.set(el.id, { id: el.id, members: el.members ?? [], tags: el.tags ?? {} });
    }
  }
});

// Pass 2: member ways of the kept relations that pass 1 did not keep.
const missing = new Set();
for (const rel of relations.values()) {
  for (const m of rel.members) if (m.type === 'way' && !ways.has(m.ref)) missing.add(m.ref);
}
if (missing.size > 0) {
  await scan((items) => {
    for (const el of items) {
      if (el.type !== 'way' || !missing.has(el.id)) continue;
      ways.set(el.id, { id: el.id, refs: el.refs ?? [], tags: el.tags ?? {} });
      for (const r of el.refs ?? []) keptNodeIds.add(r);
      missing.delete(el.id);
      if (missing.size === 0) return 'stop';
    }
  });
}
for (const rel of relations.values()) {
  for (const m of rel.members) if (m.type === 'node') keptNodeIds.add(m.ref);
}

// Pass 3: coordinates and tags of every kept node.
const nodes = new Map();
await scan((items) => {
  for (const el of items) {
    if (el.type !== 'node' || !keptNodeIds.has(el.id)) continue;
    nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags ?? {} });
    if (nodes.size === keptNodeIds.size) return 'stop';
  }
});

console.error(`slice: ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`);

// --- write ----------------------------------------------------------------
const strings = ['']; // index 0 must be the empty string
const stringIndex = new Map();
const sid = (s) => {
  let i = stringIndex.get(s);
  if (i === undefined) {
    i = strings.length;
    strings.push(s);
    stringIndex.set(s, i);
  }
  return i;
};

const GRANULARITY = 1e7; // PrimitiveBlock.granularity 100 => 100 nanodegrees

function blockOf(group) {
  return { stringtable: { s: strings.map((s) => Buffer.from(s, 'utf8')) }, primitivegroup: [group] };
}

const sortedNodes = [...nodes.values()].sort((a, b) => a.id - b.id);
const dense = { id: [], lat: [], lon: [], keys_vals: [] };
let lastId = 0, lastLat = 0, lastLon = 0;
for (const n of sortedNodes) {
  const lat = Math.round(n.lat * GRANULARITY);
  const lon = Math.round(n.lon * GRANULARITY);
  dense.id.push(n.id - lastId);
  dense.lat.push(lat - lastLat);
  dense.lon.push(lon - lastLon);
  lastId = n.id;
  lastLat = lat;
  lastLon = lon;
  for (const [k, v] of Object.entries(n.tags)) dense.keys_vals.push(sid(k), sid(v));
  dense.keys_vals.push(0);
}

const wayMsgs = [...ways.values()]
  .sort((a, b) => a.id - b.id)
  .map((w) => {
    const refs = [];
    let last = 0;
    for (const r of w.refs) {
      refs.push(r - last);
      last = r;
    }
    const keys = [], vals = [];
    for (const [k, v] of Object.entries(w.tags)) {
      keys.push(sid(k));
      vals.push(sid(v));
    }
    return { id: w.id, keys, vals, refs };
  });

const relMsgs = [...relations.values()]
  .sort((a, b) => a.id - b.id)
  .map((r) => {
    const memids = [], types = [], roles_sid = [];
    let last = 0;
    for (const m of r.members) {
      memids.push(m.ref - last);
      last = m.ref;
      types.push(['node', 'way', 'relation'].indexOf(m.type));
      roles_sid.push(sid(m.role ?? ''));
    }
    const keys = [], vals = [];
    for (const [k, v] of Object.entries(r.tags)) {
      keys.push(sid(k));
      vals.push(sid(v));
    }
    return { id: r.id, keys, vals, memids, types, roles_sid };
  });

// The string table has to be complete before any block that uses it is encoded,
// so the three blocks are built here, after every sid() call above.
const blocks = [blockOf({ dense }), blockOf({ ways: wayMsgs }), blockOf({ relations: relMsgs })];

function blob(type, body) {
  const zlib_data = deflateSync(body);
  const blobPbf = new Pbf();
  BlobData.write({ raw_size: body.length, zlib_data }, blobPbf);
  const data = Buffer.from(blobPbf.finish());
  const headerPbf = new Pbf();
  BlobHeader.write({ type, datasize: data.length }, headerPbf);
  const header = Buffer.from(headerPbf.finish());
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, data]);
}

function encode(write, obj) {
  const pbf = new Pbf();
  write(obj, pbf);
  return Buffer.from(pbf.finish());
}

const header = encode(HeaderBlock.write, {
  bbox: {
    left: Math.round(west * 1e9),
    right: Math.round(east * 1e9),
    top: Math.round(north * 1e9),
    bottom: Math.round(south * 1e9),
  },
  required_features: ['OsmSchema-V0.6', 'DenseNodes'],
  optional_features: [],
  writingprogram: 'maprama-osm make-pbf-fixture',
  source: input,
});

const out = [blob('OSMHeader', header), ...blocks.map((b) => blob('OSMData', encode(PrimitiveBlock.write, b)))];
writeFileSync(output, Buffer.concat(out));
console.error(`wrote ${output} (${Buffer.concat(out).length} bytes)`);
