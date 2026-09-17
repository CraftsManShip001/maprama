#!/usr/bin/env node
/**
 * Visual and behavioural harness for streamed tile worlds.
 *
 *   node scripts/tile-shots.mjs            everything below
 *   node scripts/tile-shots.mjs --only rebase
 *
 * It serves `dev/` and the generated archive (`.fixtures/streaming.pmtiles`,
 * built by `make-tile-fixture.mjs` if missing) over a server that answers
 * **HTTP range requests** and sends the CORS headers a real CDN has to send,
 * then drives headless Chrome over the DevTools protocol.
 *
 * What it produces, in `.screenshots/`:
 *
 * - `tiles-*.png` — the scenes a reviewer has to look at: a tile boundary, the
 *   water edge, the attribution line, a region the archive has no tiles for,
 *   and the overview level.
 * - `rebase-before.png` / `rebase-after.png` — **the proof**. The camera is
 *   parked, a frame is captured, the camera is then walked past the re-base
 *   threshold and walked back to the same geographic point, and a second frame
 *   is captured. The two images must be identical, pixel for pixel, with the
 *   render anchor provably different between them. Anything else means the
 *   re-base is visible, and the script says so and exits non-zero.
 *
 * And, on stdout: the number of HTTP requests and bytes a session costs, the
 * frame-time distribution while panning across tile boundaries, and the idle
 * frame count of a settled tile map (which must be 0).
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.screenshots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] || '').split(',')) : null;
const want = (name) => !only || only.has(name);
const W = 390, H = 760;

const FIXTURE = join(root, '.fixtures', 'streaming.pmtiles');
/** The fixture's Seoul block, and a point the archive has no tiles for. */
const SEOUL = { lng: 127.056, lat: 37.5445 };
const EMPTY = { lng: 128.0, lat: 36.4 };

if (!existsSync(FIXTURE)) {
  console.log('tile-shots: building the fixture archive first');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(root, 'scripts/make-tile-fixture.mjs')], { stdio: 'inherit' });
}

mkdirSync(outDir, { recursive: true });

// ---- playground bundle ----
await esbuild.build({
  entryPoints: [join(root, 'dev/main.ts')],
  outfile: join(root, 'dev/build/main.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], logLevel: 'warning',
});

// ---- static server with range support ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.glb': 'model/gltf-binary', '.pmtiles': 'application/octet-stream' };
let httpRequests = 0, httpBytes = 0, rangeRequests = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let base = join(root, 'dev');
  if (p.startsWith('/dist/')) { base = join(root, 'dist'); p = p.slice('/dist'.length); }
  else if (p.startsWith('/fixtures/')) { base = join(root, '.fixtures'); p = p.slice('/fixtures'.length); }
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(base, p));
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  const isArchive = base.endsWith('.fixtures');
  if (isArchive) httpRequests++;
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || 'application/octet-stream';
  // A real archive host has to answer ranges and expose the headers the reader
  // reads; the engine document's origin is `null`, so everything is cross-origin.
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    if (isArchive) rangeRequests++;
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start >= size) { res.writeHead(416, { ...cors, 'content-range': `bytes */${size}` }); res.end(); return; }
    if (isArchive) httpBytes += end - start + 1;
    res.writeHead(206, { ...cors, 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), etag: '"fixture"' });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  if (isArchive) httpBytes += size;
  res.writeHead(200, { ...cors, 'content-type': type, 'content-length': String(size), etag: '"fixture"' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- chrome + CDP ----
const profile = mkdtempSync(join(tmpdir(), 'maprama-tiles-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port = 0;
for (let i = 0; i < 200 && !port; i++) {
  const f = join(profile, 'DevToolsActivePort');
  if (existsSync(f)) port = Number(readFileSync(f, 'utf8').split('\n')[0]);
  else await sleep(100);
}
if (!port) { console.error('tile-shots: Chrome did not start\n' + chromeErr.slice(-2000)); await cleanup(); process.exit(1); }

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (p) (msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result));
  } else for (const l of [...listeners]) l(msg);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cmd = (method, params) => send(method, params, sessionId);
await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Log.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

let consoleErrors = [];
listeners.add((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push(msg.params.entry.text);
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.text);
});

const evaluate = async (expression, awaitPromise = true) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
  return r.result.value;
};

let loadCount = 0;
async function load(hash) {
  consoleErrors = [];
  // A hash-only navigation does not reload the document, and the playground
  // reads its parameters once at module load: the query string forces a real
  // load for every scene.
  await cmd('Page.navigate', { url: `${origin}/?n=${++loadCount}#${hash}` });
  const deadline = Date.now() + 60000;
  for (;;) {
    if (await evaluate('!!window.__MAPRAMA_READY__', false)) break;
    if (Date.now() > deadline) throw new Error(`timed out waiting for #${hash}`);
    await sleep(120);
  }
}

async function shot(name) {
  const { data } = await cmd('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return { file, data };
}

/**
 * Minimal PNG reader (8-bit RGB/RGBA, no interlace — what Chrome's
 * `Page.captureScreenshot` produces), so two captures can be compared as
 * pixels instead of as bytes. Byte equality is the wrong test: two identical
 * images can still encode differently, and a one-pixel difference should be
 * reported as one pixel, not as "the whole frame changed".
 */
function decodePng(buffer) {
  let pos = 8; // signature
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], colorType = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = raw[rp++];
      let recon;
      switch (filter) {
        case 0: recon = v; break;
        case 1: recon = v + a; break;
        case 2: recon = v + b; break;
        case 3: recon = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          recon = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      row[x] = recon & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Differing pixels and the largest channel difference between two captures. */
function comparePng(aBuf, bBuf) {
  const a = decodePng(aBuf), b = decodePng(bBuf);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return { pixels: a.width * a.height, maxDelta: 255, total: a.width * a.height };
  let pixels = 0, maxDelta = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let i = 0, p = 0; i < a.data.length; i += a.channels, p++) {
    let d = 0;
    for (let c = 0; c < a.channels; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d > 0) {
      pixels++;
      if (d > maxDelta) maxDelta = d;
      const x = p % a.width, y = (p / a.width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const box = pixels ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  return { pixels, maxDelta, total: a.width * a.height, box };
}

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

/* --------------------------------------------------------------- scenes */

const BASE = 'panel=0&layout=tiles&preset=urban&tod=day&ui=1&labels=holo&zo=keepGameView';
const SCENES = [
  // The fixture's Seoul block is 6 x 6 detail tiles starting at `lng`/`lat`; a
  // z15 tile is 970 m, so 121.25 world units. Framing the middle of the block
  // (x = z = 3 tiles) puts tile boundaries through the middle of the frame.
  //
  // A tile boundary down the middle: roads, pads and buildings from two
  // different tiles have to meet with nothing between them.
  { name: 'tiles-boundary', hash: `${BASE}&x=364&z=364&dist=70&pitch=45&bearing=0` },
  // The synthetic river runs east-west through every tile of the block, clipped
  // at the east and west clip edges. Its banks must follow the water's real
  // north and south edges and never cross the river.
  { name: 'tiles-water-edge', hash: `${BASE}&x=364&z=467&dist=55&pitch=25&bearing=0` },
  // Straight down: the cleanest look at the seams between tiles.
  { name: 'tiles-topdown', hash: `${BASE}&x=364&z=364&dist=120&pitch=0&bearing=0` },
  // Straight down, tight, on the point where a tile boundary (3 x 121.25
  // units) crosses the river. Two things have to be true here at once: the
  // water of two tiles has to join with no line between it, and neither tile
  // may grow a bank along the cut. If either rule were wrong, this is the frame
  // it would show in.
  { name: 'tiles-seam-closeup', hash: `${BASE.replace('labels=holo', 'labels=off')}&x=363.75&z=467&dist=30&pitch=0&bearing=0` },
  // The archive has no tiles here. Ground, no error, no blank screen.
  { name: 'tiles-empty-region', hash: `${BASE}&dist=70&pitch=45&bearing=0&lng=${EMPTY.lng}&lat=${EMPTY.lat}` },
  // The edge of the data: half the frame has tiles, half has none.
  { name: 'tiles-data-edge', hash: `${BASE}&x=600&z=364&dist=90&pitch=40&bearing=0` },
  // Far enough out that the streamer switches to the overview level. The
  // engine's default camera limits stop at 1,200 m, which is nowhere near far
  // enough to need z13, so the app has to raise `maxDistanceMeters` first —
  // that is a real constraint on when the overview level is reachable at all.
  { name: 'tiles-overview', hash: `${BASE}&maxDist=8000&x=364&z=364&dist=900&pitch=40&bearing=0` },
  // Night, so the attribution line is read against the dark HUD too.
  { name: 'tiles-night', hash: `${BASE.replace('tod=day', 'tod=night')}&x=364&z=364&dist=60&pitch=50&bearing=28` },
];

if (want('scenes')) {
  console.log('\nscenes');
  for (const s of SCENES) {
    await load(s.hash);
    await shot(s.name);
    const info = await evaluate(`(() => {
      const w = window.__engine.scene.world();
      const a = document.querySelector('.mpr-attrib');
      return { kind: w.kind, buildings: w.buildings.length, edges: w.graph.edges.length, attribution: a && !a.hidden ? a.textContent : null };
    })()`);
    check(info.kind === 'tiles', `${s.name}: world kind is tiles`);
    check(!!info.attribution, `${s.name}: attribution is displayed (${JSON.stringify(info.attribution)})`);
    check(consoleErrors.length === 0, `${s.name}: no console errors${consoleErrors.length ? ` — ${consoleErrors[0]}` : ''}`);
    console.log(`       ${s.name}: ${info.buildings} buildings, ${info.edges} road edges`);
  }
}

/* -------------------------------------------------------------- re-base */

if (want('rebase')) {
  console.log('\nre-base — the frame on either side of the anchor moving');
  // The test has to isolate *the anchor moving* from everything else that could
  // change the picture. Flying away and back does not: the streamer legitimately
  // ends up with a different set of tiles loaded, the world's bounds change with
  // it, and the ground plane that is sized from those bounds changes the frame
  // on its own. (Measured: a 1 km round trip, far too short to re-base, already
  // moves ~8,000 pixels.)
  //
  // So the anchor is moved *in place*: the scene is left completely alone, the
  // re-base threshold is dropped to a millimetre, and one frame is run. The
  // camera does not move, no tile is requested or dropped, nothing animates —
  // the only thing that happens is that the world's origin jumps onto the camera
  // and every coordinate in it is translated. If that is invisible, the two
  // captures are identical; if it is not, they are not.
  for (const variant of [
    { name: 'shadows off', extra: '&shadows=0', strict: true },
    { name: 'shadows on', extra: '', strict: false },
  ]) {
    // `realistic` keeps ambient traffic off and no character is added, so
    // nothing on screen animates by itself. Markers, info cards and holo labels
    // are on, because they are exactly what must move with the world.
    await load(`${BASE.replace('preset=urban', 'preset=realistic')}${variant.extra}&x=364&z=364&dist=70&pitch=45&bearing=0&markers=3&cards=2&cardAnchor=ground`);
    const suffix = variant.strict ? '' : '-shadows';

    const before = await evaluate(`(() => {
      const s = window.__engine.scene, o = s.camera.orbit, w = s.world();
      return { anchor: w.origin, center: s.toLngLat({ x: o.x, z: o.z }), orbit: { x: o.x, z: o.z, distance: o.distance, pitch: o.pitch, bearing: o.bearing },
               shape: { buildings: w.buildings.length, edges: w.graph.edges.length, pads: w.pads.length } };
    })()`);
    const shotBefore = await shot(`rebase-before${suffix}`);

    // Control: the same scene, untouched, 20 frames later. This is the floor of
    // the measurement, and it must be zero for the comparison to mean anything.
    await evaluate(`(async () => {
      const s = window.__engine.scene;
      const hold = s.addActiveSource('control');
      await new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= 20) { off(); r(); } }); });
      hold();
    })()`);
    const control = comparePng(Buffer.from(shotBefore.data, 'base64'), Buffer.from((await shot(`rebase-control${suffix}`)).data, 'base64'));
    check(control.pixels === 0, `  ${variant.name}: the still scene is frame-stable (control: ${control.pixels} pixels, max ${control.maxDelta})`);

    const after = await evaluate(`(async () => {
      const s = window.__engine.scene;
      const tiles = s.tileWorld();
      if (!tiles) throw new Error('not a tile world');
      const hold = s.addActiveSource('rebase-measure');
      const frames = (n) => new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= n) { off(); r(); } }); });
      try {
        // A millimetre of tolerance: the camera is already 2.9 km from the
        // anchor, so the next frame re-bases onto it. Nothing else changes.
        tiles.rebaseMeters = 0.001;
        await frames(4);
        tiles.rebaseMeters = ${JSON.stringify(5000)};
        await frames(4);
        const o = s.camera.orbit, w = s.world();
        return { anchor: w.origin, center: s.toLngLat({ x: o.x, z: o.z }), orbit: { x: o.x, z: o.z, distance: o.distance, pitch: o.pitch, bearing: o.bearing },
                 shape: { buildings: w.buildings.length, edges: w.graph.edges.length, pads: w.pads.length } };
      } finally { hold(); }
    })()`);
    const shotAfter = await shot(`rebase-after${suffix}`);

    const anchorMoved = Math.abs(after.anchor.lng - before.anchor.lng) > 1e-9 || Math.abs(after.anchor.lat - before.anchor.lat) > 1e-9;
    const orbitMoved = Math.abs(after.orbit.x - before.orbit.x) > 1e-9 || Math.abs(after.orbit.z - before.orbit.z) > 1e-9;
    const dLng = Math.abs(after.center.lng - before.center.lng), dLat = Math.abs(after.center.lat - before.center.lat);
    const diff = comparePng(Buffer.from(shotBefore.data, 'base64'), Buffer.from(shotAfter.data, 'base64'));

    check(anchorMoved, `  ${variant.name}: the anchor moved (${before.anchor.lng.toFixed(5)},${before.anchor.lat.toFixed(5)} → ${after.anchor.lng.toFixed(5)},${after.anchor.lat.toFixed(5)})`);
    check(orbitMoved, `  ${variant.name}: the camera's world coordinates moved with it (x ${before.orbit.x.toFixed(2)} → ${after.orbit.x.toFixed(2)})`);
    check(dLng < 1e-9 && dLat < 1e-9, `  ${variant.name}: the camera is looking at the same coordinate as before (Δ ${(dLng * 1e9).toFixed(2)}e-9°, ${(dLat * 1e9).toFixed(2)}e-9°)`);
    check(JSON.stringify(after.shape) === JSON.stringify(before.shape), `  ${variant.name}: the same world content is loaded (${JSON.stringify(after.shape)})`);
    if (variant.strict) {
      // Not bit-identical, and it cannot be: the geometry is re-baked around
      // the new origin, so every vertex lands on a slightly different float32,
      // and the edge pixels it half-covers get a slightly different coverage.
      // What matters is the size of that difference. A channel difference of 2
      // out of 255 is below the renderer's own dithering and an order of
      // magnitude below anything an eye resolves; 8 is where a flat surface
      // starts to band. The bar is 2.
      const pct = ((diff.pixels / diff.total) * 100).toFixed(2);
      console.log(`       ${variant.name}: ${diff.pixels} of ${diff.total} pixels differ (${pct} %), largest channel difference ${diff.maxDelta} of 255`);
      check(diff.maxDelta <= 2, `  ${variant.name}: nothing moved across the re-base — every pixel is within 2/255 (max ${diff.maxDelta})`);
    } else {
      // With a shadow map in the scene the claim has to be weaker and said out
      // loud: the map is rasterised in world space from a texel grid anchored on
      // the sun target, so translating the world re-samples every shadow edge by
      // a fraction of a texel. It is the same artefact an ordinary sub-texel pan
      // produces, and it is reported rather than hidden.
      const pct = ((diff.pixels / diff.total) * 100).toFixed(2);
      console.log(`       ${variant.name}: ${diff.pixels} of ${diff.total} pixels differ (${pct} %), largest channel difference ${diff.maxDelta} of 255 — shadow-map re-sampling`);
      check(diff.maxDelta <= 48, `  ${variant.name}: the difference stays within shadow-map noise (max channel difference ${diff.maxDelta})`);
    }
  }
}

/* ---------------------------------------------- idle frames and pan cost */

if (want('idle')) {
  console.log('\nidle frames (a settled tile map must render nothing at all)');
  // `realistic` first: nothing in the scene animates, so the answer has to be a
  // hard zero. Then `urban`, whose ambient traffic drives the loop forever by
  // design — there the point is that the streamer is *not* among the sources,
  // i.e. waiting for the network never keeps the loop awake.
  for (const preset of ['realistic', 'urban']) {
    await load(`${BASE.replace('preset=urban', `preset=${preset}`)}&x=364&z=364&dist=70&pitch=45&bearing=0`);
    const idle = await evaluate(`(async () => {
      const s = window.__engine.scene;
      await new Promise((r) => setTimeout(r, 2500));
      const a = s.frames();
      await new Promise((r) => setTimeout(r, 5000));
      return { frames: s.frames() - a, sources: s.activeSources() };
    })()`);
    if (preset === 'realistic') {
      check(idle.frames === 0, `  ${preset}: 0 frames in 5 s of a settled tile map (got ${idle.frames}; sources ${JSON.stringify(idle.sources)})`);
    } else {
      check(!idle.sources.includes('tiles'), `  ${preset}: the streamer holds no render source once the tiles are in (sources ${JSON.stringify(idle.sources)}, ${idle.frames} frames — ambient traffic, not tiles)`);
    }
  }
}

if (want('pan')) {
  console.log('\ncost of re-assembling the world (this is the honest weak spot)');
  await load(`${BASE.replace('preset=urban', 'preset=realistic')}&x=364&z=364&dist=70&pitch=45&bearing=0`);
  const rebuild = await evaluate(`(async () => {
    const s = window.__engine.scene, tiles = s.tileWorld();
    const hold = s.addActiveSource('rebuild-measure');
    const frame = () => new Promise((r) => { const off = s.onFrame(() => { off(); r(); } ); });
    const times = [];
    try {
      for (let i = 0; i < 12; i++) {
        await frame();
        const t0 = performance.now();
        // Forcing a re-base makes the engine do exactly what a tile arrival
        // makes it do: re-assemble the world and rebuild every renderer.
        tiles.rebaseMeters = 0.001;
        await frame();
        tiles.rebaseMeters = 5000;
        times.push(performance.now() - t0);
        s.camera.panBy(4, 0);
      }
    } finally { hold(); }
    times.sort((a, b) => a - b);
    return { median: times[times.length >> 1], min: times[0], max: times[times.length - 1], world: s.world().buildings.length };
  })()`);
  console.log(`       one full re-assemble + renderer rebuild of a ${rebuild.world}-building world: ${rebuild.median.toFixed(0)} ms median (${rebuild.min.toFixed(0)}–${rebuild.max.toFixed(0)} ms)`);

  console.log('\npanning across tile boundaries (frame-time distribution, not fps)');
  await load(`${BASE.replace('preset=urban', 'preset=realistic')}&x=364&z=364&dist=70&pitch=45&bearing=0`);
  const pan = await evaluate(`(async () => {
    const s = window.__engine.scene;
    const times = [];
    let last = performance.now();
    const off = s.onFrame(() => { const now = performance.now(); times.push(now - last); last = now; });
    const hold = s.addActiveSource('pan-measure');
    // Pan roughly three tiles east, one step per frame, so every tile boundary
    // in the way is crossed while the loop is running.
    for (let i = 0; i < 240; i++) {
      s.camera.panBy(1.6, 0);
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    hold();
    off();
    const sorted = [...times].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const median = q(0.5);
    return { n: times.length, p50: median, p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1], spikes: times.filter((t) => t > median * 3).length };
  })()`);
  console.log(`       ${pan.n} frames — p50 ${pan.p50.toFixed(1)} ms, p90 ${pan.p90.toFixed(1)} ms, p99 ${pan.p99.toFixed(1)} ms, max ${pan.max.toFixed(1)} ms`);
  console.log(`       ${pan.spikes} frames took more than 3x the median: that is the world being re-assembled as tiles arrive and drop.`);
  console.log('       (headless software GL on this machine; a relative measure, not a device number)');
}

/* ------------------------------------------------------------- memory */

if (want('memory')) {
  console.log('\nmemory (what a tile budget actually costs)');
  // `performance.memory` is Chrome-only and coarse, and it measures the JS heap
  // only — GPU buffers are not in it. It is still the number that answers "does
  // the budget bound anything?", which is what the budget exists for.
  for (const budget of [16, 96]) {
    await load(`${BASE.replace('preset=urban', 'preset=realistic')}&budget=${budget}&x=364&z=364&dist=70&pitch=45&bearing=0`);
    const m = await evaluate(`(async () => {
      const e = window.__engine, s = e.scene, tiles = s.tileWorld();
      const hold = s.addActiveSource('memory-measure');
      const frames = (n) => new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= n) { off(); r(); } }); });
      const quiet = async () => { let q = 0; await new Promise((r) => { const off = s.onFrame(() => { q = s.activeSources().includes('tiles') ? 0 : q + 1; if (q > 20) { off(); r(); } }); }); };
      const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
      try {
        const before = heap();
        // Walk a few tiles east and back so the cache fills to its cap.
        for (const dx of [0, 200, 400, 600, 400, 200, 0]) {
          await e.dispatch({ type: 'setCamera', camera: { center: s.toLngLat({ x: dx, z: 364 }) } });
          await quiet();
          await frames(4);
        }
        const st = tiles.stats();
        return { before, after: heap(), loaded: st.loaded, empty: st.empty, buildings: s.world().buildings.length };
      } finally { hold(); }
    })()`);
    const mb = (b) => (b / 1024 / 1024).toFixed(1);
    console.log(`       budget ${String(budget).padStart(3)}: ${m.loaded} tiles held (${m.empty} empty), ${m.buildings} buildings, JS heap ${mb(m.before)} → ${mb(m.after)} MiB`);
    check(m.loaded <= Math.max(budget, 25), `  budget ${budget}: the cache stayed at or under its cap (${m.loaded} tiles)`);
  }
  console.log('       (Chrome JS heap only — GPU buffers are not counted, and the number is coarse.)');
  console.log('       note: both budgets hold the same number of tiles. What bounds the cache in practice is the');
  console.log('       distance eviction (the viewport rectangle plus a 2-tile ring), not `tileBudget`; the budget');
  console.log('       is a backstop, and it also decides when the overview level takes over.');
}

/* ------------------------------------------------- how far is too far */

if (want('precision')) {
  console.log('\nprecision — what distance from the render anchor does to the picture');
  // The fixture has four `probe-*` blocks with byte-identical content at the
  // same latitude, 44 / 175 / 350 / 700 km east of Seoul. With the re-base
  // threshold pushed out of reach, the anchor stays put and each block is drawn
  // at a different distance from the world origin. Any difference between the
  // frames is what the distance did — which is the empirical version of the
  // float32 argument, and the number the re-base threshold should follow.
  const TILE_DEG = 360 / 2 ** 15;
  // The blocks are a whole number of tiles apart (see make-tile-fixture.mjs), so
  // the camera lands at the same position inside a tile in every one of them and
  // the loaded tile set is the same shape each time.
  // The list starts with the reference block twice: the second capture of the
  // same block on the same route is the floor of the measurement, and anything
  // the other blocks show has to be read against it.
  const PROBES = [64, 64, 72, 80, 96, 128, 192, 256, 512, 1024].map((n) => ({ tiles: n, lng: 127.056 + n * TILE_DEG }));
  const shots = [];
  for (const probe of PROBES) {
    // Each run opens the world *at* the probe block, so the block is right in
    // front of the camera; the drift is created afterwards by loading with the
    // anchor set to the first block and flying east without re-basing.
    await load(`${BASE.replace('preset=urban', 'preset=realistic')}&shadows=0&labels=off&lng=${PROBES[0].lng}&lat=37.5445&x=60&z=60&dist=60&pitch=45&bearing=0`);
    const info = await evaluate(`(async () => {
      const e = window.__engine, s = e.scene, tiles = s.tileWorld();
      // Pin the anchor: this is the whole experiment.
      tiles.rebaseMeters = 1e9;
      const hold = s.addActiveSource('precision');
      const frames = (n) => new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= n) { off(); r(); } }); });
      const quiet = async () => { let q = 0; await new Promise((r) => { const off = s.onFrame(() => { q = s.activeSources().includes('tiles') ? 0 : q + 1; if (q > 30) { off(); r(); } }); }); };
      try {
        // Every run takes the same route: out to an empty region first, then in
        // to its probe block. Without the detour the reference run would never
        // evict its start-up tiles and would end up with a different set loaded
        // than the runs that flew, which would swamp the thing being measured.
        await e.dispatch({ type: 'setCamera', camera: { center: { lng: 128.0, lat: 36.4 } } });
        await quiet();
        await frames(5);
        await e.dispatch({ type: 'setCamera', camera: ${JSON.stringify({ center: { lng: probe.lng + 0.0044, lat: 37.5445 - 0.0035 } })} });
        await quiet();
        await frames(10);
        const o = s.camera.orbit, w = s.world();
        return { orbitX: o.x, orbitZ: o.z, anchor: w.origin, buildings: w.buildings.length,
                 driftKm: +((Math.hypot(o.x, o.z) * 8) / 1000).toFixed(1) };
      } finally { hold(); }
    })()`);
    const shot1 = await shot(`precision-${shots.length === 0 ? 'ref' : `${probe.tiles}tiles-${shots.length}`}`);
    shots.push({ probe, info, data: shot1.data });
    console.log(`       block +${String(probe.tiles).padStart(4)} tiles: anchor drift ${String(info.driftKm).padStart(6)} km, ${info.buildings} buildings, world x ${info.orbitX.toFixed(0)}`);
  }
  const ref = shots[0];
  shots.slice(1).forEach((s2, i) => {
    const d = comparePng(Buffer.from(ref.data, 'base64'), Buffer.from(s2.data, 'base64'));
    const pct = ((d.pixels / d.total) * 100).toFixed(2);
    const label = i === 0 ? 'the SAME block again (control)' : `a block ${String(s2.info.driftKm).padStart(6)} km out`;
    console.log(`       vs ${label.padEnd(32)}: ${String(d.pixels).padStart(6)} px differ (${pct.padStart(5)} %), max channel difference ${String(d.maxDelta).padStart(3)} of 255`);
  });
  console.log('       (identical content, identical framing, identical route: the only variable is the distance from the anchor.');
  console.log('        the pixel *count* depends on where edges happen to fall and is noisy; the max channel difference is the signal.)');
}

console.log(`\narchive traffic: ${httpRequests} requests (${rangeRequests} ranged), ${(httpBytes / 1024).toFixed(1)} KiB transferred of a ${(statSync(FIXTURE).size / 1024).toFixed(1)} KiB archive`);
console.log(`screenshots: ${outDir}`);

async function cleanup() {
  try { ws.close(); } catch { /* already gone */ }
  chrome.kill();
  server.close();
  // Chrome can still be writing into its profile as it exits.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a leftover temp profile is harmless */ }
}
await cleanup();

if (failures.length) {
  console.error(`\ntile-shots: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\ntile-shots: all checks passed');
