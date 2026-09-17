#!/usr/bin/env node
/**
 * End-to-end harness for a **real, nationwide** archive.
 *
 *   MAPRAMA_ARCHIVE=/path/south-korea.pmtiles node scripts/nationwide-shots.mjs
 *   ... --only scenes          (scenes | fly | rebuild | overview | idle | memory)
 *   MAPRAMA_SCENES=/path/scenes.json  replaces the built-in scene list, so the
 *   same harness can shoot an A/B pair of archives at places the built-in list
 *   does not visit (a source swap on one layer, say). The file is an array of
 *   `{ name, label, lng, lat, hash, expect }`, the shape of SCENES below.
 *   MAPRAMA_SHOTS=/path/dir  writes the PNGs somewhere other than
 *   .screenshots-nationwide, so an A/B pair does not overwrite itself.
 *
 * Unlike `tile-shots.mjs`, which drives a synthetic fixture with a made-up
 * Seoul block and a straight synthetic river, this one serves the archive the
 * pipeline actually produced from the Geofabrik South Korea extract and flies
 * the camera to real places. The point is the chain, not the renderer: OSM PBF
 * → MTIL/PMTiles → HTTP range → streamer → world → picture.
 *
 * The server sends `Access-Control-Allow-Origin: *` and exposes `Content-Range`,
 * because the engine document's origin is `null` and every archive read is
 * therefore cross-origin.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.MAPRAMA_SHOTS || join(root, '.screenshots-nationwide');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARCHIVE = process.env.MAPRAMA_ARCHIVE;
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? new Set((argv[onlyIdx + 1] || '').split(',')) : null;
const want = (name) => !only || only.has(name);
const W = 390, H = 760;

if (!ARCHIVE || !existsSync(ARCHIVE)) {
  console.error(`nationwide-shots: set MAPRAMA_ARCHIVE to the archive file (got ${JSON.stringify(ARCHIVE)})`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'dev/main.ts')],
  outfile: join(root, 'dev/build/main.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], logLevel: 'warning',
});

// ---- static server with range support + CDN-like CORS ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.glb': 'model/gltf-binary', '.pmtiles': 'application/octet-stream' };
const ARCHIVE_ROUTE = `/archive/${basename(ARCHIVE)}`;
let httpRequests = 0, httpBytes = 0, rangeRequests = 0;
const resetTraffic = () => { httpRequests = 0; httpBytes = 0; rangeRequests = 0; };
const cors = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
  'accept-ranges': 'bytes',
  'cache-control': 'no-store',
};
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let file, isArchive = false;
  if (p === ARCHIVE_ROUTE) { file = ARCHIVE; isArchive = true; }
  else {
    let base = join(root, 'dev');
    if (p.startsWith('/dist/')) { base = join(root, 'dist'); p = p.slice('/dist'.length); }
    if (p.endsWith('/')) p += 'index.html';
    file = normalize(join(base, p));
    if (!file.startsWith(base)) { res.writeHead(404); res.end('not found'); return; }
  }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  if (isArchive) httpRequests++;
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    if (isArchive) rangeRequests++;
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start >= size) { res.writeHead(416, { ...cors, 'content-range': `bytes */${size}` }); res.end(); return; }
    if (isArchive) httpBytes += end - start + 1;
    res.writeHead(206, { ...cors, 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), etag: '"kr"' });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  if (isArchive) httpBytes += size;
  res.writeHead(200, { ...cors, 'content-type': type, 'content-length': String(size), etag: '"kr"' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const ARCHIVE_URL = `${origin}${ARCHIVE_ROUTE}`;

// ---- chrome + CDP ----
const profile = mkdtempSync(join(tmpdir(), 'maprama-kr-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', '--js-flags=--expose-gc', `--window-size=${W},${H}`, 'about:blank',
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
if (!port) { console.error('nationwide-shots: Chrome did not start\n' + chromeErr.slice(-2000)); await cleanup(); process.exit(1); }

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

// Records, in the page and from the first script that runs in the document, the
// moment the first building exists in the rendered world. That is the number a
// user feels: "screen opened" to "something is there".
await cmd('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__t0 = performance.now();
    window.__firstBuilding = null;
    const tick = () => {
      try {
        const w = window.__engine?.scene?.world?.();
        if (w && w.buildings && w.buildings.length > 0) { window.__firstBuilding = performance.now() - window.__t0; return; }
      } catch {}
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`,
});

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
  await cmd('Page.navigate', { url: `${origin}/?n=${++loadCount}#${hash}` });
  // An overview world is ~7,600 buildings and renders at a fraction of a frame
  // per second on headless software GL; the deadline has to allow for that.
  const deadline = Date.now() + Number(process.env.MAPRAMA_LOAD_TIMEOUT_MS || 600000);
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
 * Decodes a PNG (the only ones here are Chrome's own screenshots: 8-bit
 * truecolour, possibly with alpha) to raw RGB. Small enough to keep the harness
 * dependency-free, which is the point.
 */
function pngPixels(buf) {
  let i = 8, idat = [], w = 0, h = 0, ct = 0;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(i + 8); h = buf.readUInt32BE(i + 12); ct = buf[i + 17]; }
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const out = Buffer.alloc(w * h * bpp);
  let prev = Buffer.alloc(stride), pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, bpp, px: out };
}

/** Worst per-channel difference between two screenshots, and how many pixels differ at all. */
function pngMaxDiff(a, b) {
  const A = pngPixels(a), B = pngPixels(b);
  if (A.w !== B.w || A.h !== B.h) return { max: 255, differing: A.w * A.h, pixels: A.w * A.h };
  let max = 0, differing = 0;
  for (let i = 0; i < A.w * A.h; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A.px[i * A.bpp + k] - B.px[i * B.bpp + k]));
    if (d > 0) differing++;
    if (d > max) max = d;
  }
  return { max, differing, pixels: A.w * A.h };
}

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

/* --------------------------------------------------------------- scenes */

const BASE = `panel=0&layout=tiles&preset=urban&tod=day&ui=1&labels=holo&zo=keepGameView&tiles=${encodeURIComponent(ARCHIVE_URL)}`;

/** Real places. `expect` is what the scene has to show for the chain to be working. */
const SCENES = process.env.MAPRAMA_SCENES
  ? JSON.parse(readFileSync(process.env.MAPRAMA_SCENES, 'utf8'))
  : [
  { name: 'kr-01-gangnam', label: '서울 강남역', lng: 127.0276, lat: 37.4979, hash: 'dist=70&pitch=45&bearing=20', expect: 'buildings' },
  { name: 'kr-02-seongsu', label: '서울 성수동', lng: 127.0557, lat: 37.5447, hash: 'dist=70&pitch=45&bearing=0', expect: 'buildings' },
  { name: 'kr-03-busan-seomyeon', label: '부산 서면', lng: 129.0596, lat: 35.1577, hash: 'dist=70&pitch=45&bearing=0', expect: 'buildings' },
  // A z15 tile boundary (lng 126.990967) lying across the Han river at Banpo.
  // The tile-format spec was wrong here once: a renderer that treats the clip
  // edge as a real shore builds a wall or a green band down the middle of the water.
  { name: 'kr-04-han-seam', label: '한강 타일 경계 (반포)', lng: 126.990967, lat: 37.5175, hash: 'dist=60&pitch=0&bearing=0&labels=off', expect: 'water' },
  { name: 'kr-05-han-seam-oblique', label: '한강 타일 경계 (비스듬히)', lng: 126.990967, lat: 37.5175, hash: 'dist=70&pitch=35&bearing=0&labels=off', expect: 'water' },
  { name: 'kr-06-gurye', label: '전남 구례', lng: 127.4626, lat: 35.2024, hash: 'dist=70&pitch=45&bearing=0', expect: 'sparse' },
  { name: 'kr-07-namwon', label: '전북 남원', lng: 127.3906, lat: 35.4164, hash: 'dist=70&pitch=45&bearing=0', expect: 'sparse' },
  { name: 'kr-08-odaesan', label: '강원 오대산', lng: 128.5433, lat: 37.7944, hash: 'dist=80&pitch=40&bearing=0', expect: 'nearly-empty' },
  { name: 'kr-09-open-sea', label: '동해 바다 (타일 없음)', lng: 129.8, lat: 35.0, hash: 'dist=70&pitch=45&bearing=0', expect: 'empty' },
  // The default camera stops at 1,200 m, nowhere near the z13 overview level:
  // `maxDistanceMeters` has to be raised before the overview is reachable at all.
  // `realistic` keeps ambient traffic out of a 7,600-building world, which is
  // otherwise minutes per frame on software GL.
  { name: 'kr-10-overview-seoul', label: '서울 오버뷰 (z13, maxDist 8000)', lng: 127.0276, lat: 37.4979, hash: 'preset=realistic&maxDist=8000&dist=900&pitch=40&bearing=0', expect: 'overview' },
  { name: 'kr-11-overview-default-cap', label: '오버뷰 시도, 기본 상한 그대로', lng: 127.0276, lat: 37.4979, hash: 'preset=realistic&dist=900&pitch=40&bearing=0', expect: 'capped' },
  { name: 'kr-12-gangnam-night', label: '강남 야경', lng: 127.0276, lat: 37.4979, hash: 'tod=night&dist=60&pitch=50&bearing=28', expect: 'buildings' },
    ];

const sceneInfo = `(() => {
  const s = window.__engine.scene, w = s.world(), t = s.tileWorld();
  const a = document.querySelector('.mpr-attrib');
  const o = s.camera.orbit;
  return {
    kind: w.kind, buildings: w.buildings.length, edges: w.graph.edges.length,
    water: (w.water || []).length, parks: (w.parks || []).length,
    attribution: a && !a.hidden ? a.textContent : null,
    stats: t ? t.stats() : null,
    distanceMeters: o.distance * w.unitMeters,
    firstBuildingMs: window.__firstBuilding,
  };
})()`;

const results = [];
if (want('scenes')) {
  console.log(`\nscenes — real places in the nationwide archive (${(statSync(ARCHIVE).size / 1024 / 1024).toFixed(1)} MiB)`);
  for (const s of SCENES) {
    resetTraffic();
    const t0 = Date.now();
    // `URLSearchParams.get` takes the first value, so a key the scene overrides
    // has to come out of the base rather than be appended after it.
    let base = BASE;
    for (const key of ['tod', 'preset', 'labels']) {
      if (new RegExp(`(^|&)${key}=`).test(s.hash)) base = base.replace(new RegExp(`(^|&)${key}=[^&]*`), '');
    }
    const hash = `${base.replace(/^&/, '')}&lng=${s.lng}&lat=${s.lat}&${s.hash}`;
    await load(hash);
    const wall = Date.now() - t0;
    await shot(s.name);
    const info = await evaluate(sceneInfo);
    results.push({ scene: s, info, wall, requests: httpRequests, ranged: rangeRequests, bytes: httpBytes });
    console.log(`\n  ${s.name}  ${s.label}`);
    console.log(`       ${info.buildings} buildings, ${info.edges} road edges, ${info.water} water, ${info.parks} parks`);
    console.log(`       tiles: ${JSON.stringify(info.stats)}  camera ${info.distanceMeters.toFixed(0)} m`);
    console.log(`       ${httpRequests} archive requests (${rangeRequests} ranged), ${(httpBytes / 1024).toFixed(1)} KiB; page ready in ${wall} ms, first building at ${info.firstBuildingMs === null ? 'never' : `${info.firstBuildingMs.toFixed(0)} ms`}`);
    check(info.kind === 'tiles', `${s.name}: world kind is tiles`);
    check(!!info.attribution, `${s.name}: attribution shown (${JSON.stringify(info.attribution)})`);
    check(consoleErrors.length === 0, `${s.name}: no console errors${consoleErrors.length ? ` — ${consoleErrors[0]}` : ''}`);
    check((info.stats?.failed ?? 0) === 0, `${s.name}: no failed tile fetches (${info.stats?.failed ?? '?'})`);
    if (s.expect === 'buildings') check(info.buildings > 100, `${s.name}: a city's worth of buildings (${info.buildings})`);
    if (s.expect === 'water') check(info.water > 0, `${s.name}: the river is in the world (${info.water} water polygons)`);
    if (s.expect === 'sparse') check(info.buildings > 0 && info.edges > 0, `${s.name}: sparse but not empty (${info.buildings} buildings, ${info.edges} edges)`);
    if (s.expect === 'empty') check(info.buildings === 0 && info.edges === 0, `${s.name}: nothing, and no error (${info.buildings} buildings, ${info.edges} edges)`);
    if (s.expect === 'overview') check(info.stats?.zoom === 13, `${s.name}: the streamer switched to the overview level (zoom ${info.stats?.zoom})`);
    if (s.expect === 'capped') console.log(`       (default cap: camera ended at ${info.distanceMeters.toFixed(0)} m, streamer zoom ${info.stats?.zoom})`);
  }
}

/* ----------------------------------------------- flying Seoul -> Busan */

if (want('fly')) {
  console.log('\nflying Seoul → Busan (325 km) — does the world survive the jump?');
  await load(`${BASE}&lng=127.0276&lat=37.4979&dist=70&pitch=45&bearing=0&preset=realistic`.replace('preset=urban&', ''));
  const before = await evaluate(`(() => { const s = window.__engine.scene, w = s.world(), o = s.camera.orbit;
    return { anchor: w.origin, buildings: w.buildings.length, orbit: { x: o.x, z: o.z }, center: s.toLngLat({ x: o.x, z: o.z }) }; })()`);
  console.log(`       Seoul: ${before.buildings} buildings, anchor ${before.anchor.lng.toFixed(4)},${before.anchor.lat.toFixed(4)}`);
  await shot('fly-01-seoul');

  const flown = await evaluate(`(async () => {
    const e = window.__engine, s = e.scene;
    const quiet = async () => { let q = 0; await new Promise((r) => { const off = s.onFrame(() => { q = s.activeSources().includes('tiles') ? 0 : q + 1; if (q > 30) { off(); r(); } }); }); };
    const hold = s.addActiveSource('fly');
    const times = []; let last = performance.now();
    const off = s.onFrame(() => { const now = performance.now(); times.push(now - last); last = now; });
    try {
      const t0 = performance.now();
      await e.dispatch({ type: 'setCamera', camera: { center: { lng: 129.0596, lat: 35.1577 } } });
      await quiet();
      const ms = performance.now() - t0;
      const o = s.camera.orbit, w = s.world();
      const sorted = [...times].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const median = q(0.5);
      return { ms, anchor: w.origin, buildings: w.buildings.length, edges: w.graph.edges.length,
               orbit: { x: o.x, z: o.z }, center: s.toLngLat({ x: o.x, z: o.z }), stats: s.tileWorld().stats(),
               frames: times.length, p50: median, p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1],
               spikes: times.filter((t) => t > median * 3).length };
    } finally { off(); hold(); }
  })()`);
  await shot('fly-02-busan');
  console.log(`       Busan: ${flown.buildings} buildings, ${flown.edges} road edges, anchor ${flown.anchor.lng.toFixed(4)},${flown.anchor.lat.toFixed(4)}`);
  console.log(`       the jump took ${flown.ms.toFixed(0)} ms and ${flown.frames} frames — p50 ${flown.p50.toFixed(1)} ms, p90 ${flown.p90.toFixed(1)} ms, p99 ${flown.p99.toFixed(1)} ms, max ${flown.max.toFixed(1)} ms; ${flown.spikes} frames over 3x median`);
  console.log(`       tiles ${JSON.stringify(flown.stats)}`);
  const anchorMoved = Math.hypot(flown.anchor.lng - before.anchor.lng, flown.anchor.lat - before.anchor.lat) > 0.5;
  check(anchorMoved, `  the render anchor followed the camera to Busan (${before.anchor.lng.toFixed(3)} → ${flown.anchor.lng.toFixed(3)})`);
  check(Math.abs(flown.center.lng - 129.0596) < 0.01 && Math.abs(flown.center.lat - 35.1577) < 0.01,
    `  the camera is looking at Seomyeon (${flown.center.lng.toFixed(4)}, ${flown.center.lat.toFixed(4)})`);
  check(Math.hypot(flown.orbit.x, flown.orbit.z) < 20000,
    `  world coordinates stayed small after the 325 km jump (|x,z| = ${Math.hypot(flown.orbit.x, flown.orbit.z).toFixed(0)} units, not ~40,000,000)`);
  check(flown.buildings > 100, `  Busan has its buildings (${flown.buildings})`);
  check(consoleErrors.length === 0, `  no console errors on the flight${consoleErrors.length ? ` — ${consoleErrors[0]}` : ''}`);

  console.log('\n  panning across real tile boundaries in Seoul');
  await load(`${BASE.replace('preset=urban', 'preset=realistic')}&lng=127.0276&lat=37.4979&dist=70&pitch=45&bearing=0`);
  const pan = await evaluate(`(async () => {
    const s = window.__engine.scene;
    const times = []; let last = performance.now();
    const off = s.onFrame(() => { const now = performance.now(); times.push(now - last); last = now; });
    const hold = s.addActiveSource('pan-measure');
    for (let i = 0; i < 240; i++) { s.camera.panBy(1.6, 0); await new Promise((r) => requestAnimationFrame(() => r())); }
    hold(); off();
    const sorted = [...times].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const median = q(0.5);
    return { n: times.length, p50: median, p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1],
             spikes: times.filter((t) => t > median * 3).length, buildings: s.world().buildings.length };
  })()`);
  console.log(`       ${pan.n} frames over a ${pan.buildings}-building world — p50 ${pan.p50.toFixed(1)} ms, p90 ${pan.p90.toFixed(1)} ms, p99 ${pan.p99.toFixed(1)} ms, max ${pan.max.toFixed(1)} ms`);
  console.log(`       ${pan.spikes} frames took more than 3x the median (world re-assembly as tiles arrive and drop)`);
  console.log('       (headless software GL — relative, not a device number)');
}

/* ------------------------------ incremental == rebuilt from nothing */

if (want('rebuild')) {
  console.log('\nthe incremental world against a full rebuild of the same tiles');
  // Labels off: the holo anchors pulse, so two frames taken seconds apart differ
  // in the *overlay* whatever the world does, and the claim under test is about
  // the world. (With them on the difference is 1,219 pixels of 296,400, every
  // one of them on a pulsing ring.)
  await load(`${BASE.replace('preset=urban', 'preset=realistic').replace('labels=holo', 'labels=off')}&lng=127.0276&lat=37.4979&dist=70&pitch=45&bearing=0`);
  // Pan far enough to cross tile boundaries several times: what is on screen is
  // then a world that grew and shrank incrementally, not one that was built.
  const panned = await evaluate(`(async () => {
    const s = window.__engine.scene;
    const hold = s.addActiveSource('rebuild-measure');
    for (let i = 0; i < 90; i++) { s.camera.panBy(1.6, 0); await new Promise((r) => requestAnimationFrame(() => r())); }
    let q = 0;
    await new Promise((r) => { const off = s.onFrame(() => { q = s.activeSources().filter((t) => t !== 'rebuild-measure').length ? 0 : q + 1; if (q > 4) { off(); r(); } }); });
    hold();
    return { buildings: s.world().buildings.length, tiles: s.tileWorld().stats().loaded };
  })()`);
  const before = await shot('rebuild-01-incremental');
  // `setTheme` with the theme already in force is the full-rebuild path: a new
  // material generation, and every renderer built again from the same world and
  // the same loaded tiles. Nothing else in the scene changes, so the two frames
  // are the same picture drawn twice — once incrementally, once from nothing.
  await evaluate(`(async () => {
    const e = window.__engine, s = e.scene;
    const hold = s.addActiveSource('rebuild-measure');
    await e.dispatch({ type: 'setTheme', theme: { base: 'realistic', timeOfDay: 'day', zoomOut: 'keepGameView' } });
    await new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= 3) { off(); r(); } }); });
    hold();
  })()`);
  const after = await shot('rebuild-02-full');
  const d = pngMaxDiff(Buffer.from(before.data, 'base64'), Buffer.from(after.data, 'base64'));
  console.log(`       ${panned.buildings} buildings over ${panned.tiles} tiles after 90 panning frames`);
  console.log(`       worst channel difference between the two frames: ${d.max} of 255 (${d.differing} of ${d.pixels} pixels differ at all)`);
  // Not "byte for byte": the full rebuild redraws the shadow map on its own
  // world-space texel grid, which lands a handful of pixels differently along
  // silhouette edges — the same artefact `tile-shots.mjs` measures across a
  // re-base (~30 of 255 with the shadow pass on). What the check is for is a
  // *changed picture*: a building that was not rebuilt when it should have
  // been, or one left behind, moves thousands of pixels, not twenty.
  check(d.differing <= 200 && d.max <= 40,
    `  the incremental world draws the same picture as a full rebuild (${d.differing} of ${d.pixels} pixels differ, worst ${d.max} of 255)`);
  check(consoleErrors.length === 0, `  no console errors${consoleErrors.length ? ` — ${consoleErrors[0]}` : ''}`);
}

/* ------------------------------------------------------------ overview */

if (want('overview')) {
  console.log('\noverview (z13) — pulling back from Gangnam to 7.2 km');
  // `realistic` and `urban` are measured separately because they are the two
  // ends of what the overview costs: `urban` adds facade details and outlines
  // to every building, so it is the preset that hurts.
  for (const preset of ['realistic', 'urban']) {
    await load(`${BASE.replace('preset=urban', `preset=${preset}`)}&lng=127.0276&lat=37.4979&maxDist=8000&dist=70&pitch=40&bearing=0`);
    const ov = await evaluate(`(async () => {
      const e = window.__engine, s = e.scene;
      const hold = s.addActiveSource('overview-measure');
      const quiet = async () => { let q = 0; await new Promise((r) => { const off = s.onFrame(() => { q = s.activeSources().includes('tiles') ? 0 : q + 1; if (q > 6) { off(); r(); } }); }); };
      const frames = (n) => new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= n) { off(); r(); } }); });
      try {
        const t0 = performance.now();
        await e.dispatch({ type: 'setCamera', camera: { distance: 7200 } });
        await quiet();
        const enter = performance.now() - t0;
        // Then 12 settled frames, with nothing streaming, to time the view itself.
        const times = []; let last = performance.now();
        const off = s.onFrame(() => { const now = performance.now(); times.push(now - last); last = now; });
        await frames(8);
        off();
        const sorted = [...times].sort((a, b) => a - b);
        const w = s.world(), t = s.tileWorld();
        return { enter, frame: sorted[Math.floor(sorted.length / 2)], worst: sorted[sorted.length - 1],
                 buildings: w.buildings.length, edges: w.graph.edges.length, stats: t.stats(),
                 distanceMeters: s.camera.orbit.distance * w.unitMeters };
      } finally { hold(); }
    })()`);
    await shot(`overview-${preset}`);
    console.log(`  ${preset}: entered in ${ov.enter.toFixed(0)} ms — ${ov.buildings} buildings, ${ov.edges} road edges over ${ov.stats.loaded} tiles at z${ov.stats.zoom}, camera ${ov.distanceMeters.toFixed(0)} m`);
    console.log(`       settled frame time: median ${ov.frame.toFixed(0)} ms, worst ${ov.worst.toFixed(0)} ms   (headless software GL)`);
    check(ov.stats.zoom === 13, `  ${preset}: the streamer is at the overview level (z${ov.stats.zoom})`);
    check(ov.buildings > 200, `  ${preset}: the overview still has a city in it (${ov.buildings} buildings)`);
    check(consoleErrors.length === 0, `  ${preset}: no console errors${consoleErrors.length ? ` — ${consoleErrors[0]}` : ''}`);
  }
}

/* ------------------------------------------------------- idle + memory */

if (want('idle')) {
  console.log('\nidle frames on a settled real-data map (must be 0)');
  for (const [label, hash] of [
    ['서울 강남', 'lng=127.0276&lat=37.4979'],
    ['오대산 (거의 빈 타일)', 'lng=128.5433&lat=37.7944'],
    ['동해 (타일 없음)', 'lng=129.8&lat=35.0'],
  ]) {
    await load(`${BASE.replace('preset=urban', 'preset=realistic')}&${hash}&dist=70&pitch=45&bearing=0`);
    const idle = await evaluate(`(async () => {
      const s = window.__engine.scene;
      await new Promise((r) => setTimeout(r, 2500));
      const a = s.frames();
      await new Promise((r) => setTimeout(r, 5000));
      return { frames: s.frames() - a, sources: s.activeSources() };
    })()`);
    check(idle.frames === 0, `  ${label}: 0 frames in 5 s (got ${idle.frames}; sources ${JSON.stringify(idle.sources)})`);
  }
}

if (want('memory')) {
  console.log('\nmemory over a nationwide session');
  await load(`${BASE.replace('preset=urban', 'preset=realistic')}&lng=127.0276&lat=37.4979&dist=70&pitch=45&bearing=0`);
  const m = await evaluate(`(async () => {
    const e = window.__engine, s = e.scene, tiles = s.tileWorld();
    const hold = s.addActiveSource('memory-measure');
    const frames = (n) => new Promise((r) => { let i = 0; const off = s.onFrame(() => { if (++i >= n) { off(); r(); } }); });
    const quiet = async () => { let q = 0; await new Promise((r) => { const off = s.onFrame(() => { q = s.activeSources().includes('tiles') ? 0 : q + 1; if (q > 30) { off(); r(); } }); }); };
    const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
    const marks = [];
    try {
      marks.push({ where: 'start (서울 강남)', heap: heap(), tiles: tiles.stats().loaded, buildings: s.world().buildings.length });
      for (const [where, c] of [
        ['서울 성수', { lng: 127.0557, lat: 37.5447 }],
        ['부산 서면', { lng: 129.0596, lat: 35.1577 }],
        ['구례', { lng: 127.4626, lat: 35.2024 }],
        ['오대산', { lng: 128.5433, lat: 37.7944 }],
        ['동해 바다', { lng: 129.8, lat: 35.0 }],
        ['서울 강남 (복귀)', { lng: 127.0276, lat: 37.4979 }],
      ]) {
        await e.dispatch({ type: 'setCamera', camera: { center: c } });
        await quiet(); await frames(4);
        marks.push({ where, heap: heap(), tiles: tiles.stats().loaded, buildings: s.world().buildings.length });
      }
      return { marks, peak: Math.max(...marks.map((x) => x.heap)), stats: tiles.stats() };
    } finally { hold(); }
  })()`);
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  for (const x of m.marks) console.log(`       ${x.where.padEnd(22)} heap ${mb(x.heap).padStart(6)} MiB, ${String(x.tiles).padStart(3)} tiles held, ${String(x.buildings).padStart(5)} buildings`);
  console.log(`       peak JS heap over the whole tour: ${mb(m.peak)} MiB  (Chrome JS heap only — GPU buffers not counted)`);
}

console.log(`\nscreenshots: ${outDir}`);

async function cleanup() {
  try { ws.close(); } catch { /* already gone */ }
  chrome.kill();
  server.close();
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* harmless */ }
}
await cleanup();

if (failures.length) {
  console.error(`\nnationwide-shots: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nnationwide-shots: all checks passed');
