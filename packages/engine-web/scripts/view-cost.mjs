// 2D vs 2.5D frame-cost harness: proves that the flat view really is the cheap one.
//
//   node scripts/view-cost.mjs [--repeats 3] [--seconds 6]
//
// Serves dev/ like scripts/idle-frames.mjs, drives headless Chrome over CDP and, for every
// (world, view mode) pair, measures the same camera twice over:
//
//   * per-frame **draw calls** and **triangles** (`renderer.info.render`, accumulated with
//     `autoReset = false` over a fixed pan and divided by the frames that were drawn). These are
//     exact and hardware independent — they count what the engine submits, including the shadow
//     depth pass — so they are the numbers to quote.
//   * **fps while panning**, on the same host, in the same run. Headless Chrome renders on
//     SwiftShader (software GL), so the absolute value means nothing; the *ratio* between the two
//     modes on one host does, because software GL is bound by exactly the fill and geometry work
//     the flat mode removes.
//   * **idle frames**: after the pan, the map is left alone and its frame counter is read twice.
//     The flat view must never idle worse than the tilted one (the run fails if it does). A world
//     can idle in both modes for its own reasons — the procedural town's landmark spire spins
//     forever — which is why the check is a comparison, not "must be 0".
//
// Every number is the median of `--repeats` runs.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const argNum = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const REPEATS = argNum('--repeats', 3);
const SECONDS = argNum('--seconds', 6);
const IDLE_SECONDS = argNum('--idle-seconds', 3);
const SETTLE_MS = argNum('--settle', 2500);
const W = 390, H = 760;

// `realistic` has ambient traffic off, so the idle half of the measurement can reach 0 frames.
// The camera is the same in both modes on purpose: same centre, same distance, same bearing. The
// pitch is not comparable (the flat view pins it at 0 — that is the mode), so it is not set here.
const WORLDS = [
  { name: 'procedural town', hash: 'layout=town', dist: 100 },
  // 428 buildings of real OSM data (tools/osm), skipped when the sample is not checked out.
  { name: 'seongsu (OSM, 428 buildings)', hash: 'layout=sample&world=/osm-samples/seongsu.world.json', dist: 90, requires: join(repo, 'tools/osm/samples/seongsu.world.json') },
];
const VIEWS = ['2.5d', '2d'];

// ---- playground bundle ----
await esbuild.build({
  entryPoints: [join(root, 'dev/main.ts')],
  outfile: join(root, 'dev/build/main.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], logLevel: 'warning',
});

// ---- static server (dev/, plus the read-only OSM samples at /osm-samples/) ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.glb': 'model/gltf-binary' };
const MOUNTS = [
  { prefix: '/osm-samples/', dir: join(repo, 'tools/osm/samples') },
  { prefix: '/', dir: join(root, 'dev') },
];
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  for (const m of MOUNTS) {
    if (!p.startsWith(m.prefix)) continue;
    const file = normalize(join(m.dir, p.slice(m.prefix.length - 1)));
    if (!file.startsWith(m.dir) || !existsSync(file) || !statSync(file).isFile()) continue;
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- chrome + CDP ----
const profile = mkdtempSync(join(tmpdir(), 'maprama-view-cost-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  `--window-size=${W},${H}`, 'about:blank',
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
if (!port) { console.error('view-cost: Chrome did not start\n' + chromeErr.slice(-2000)); process.exit(1); }
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  } else for (const l of listeners) l(m);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const evaluate = async (sessionId, expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

/** Frames the same ground box in both modes and puts the engine in `view`. */
const setUp = (view, dist) => `(async () => {
  const e = window.__engine, s = e.scene, w = s.world();
  await e.dispatch({ type: 'setCamera', camera: {
    center: s.toLngLat({ x: w.start.x, z: w.start.z }),
    distance: ${dist} * w.unitMeters,
    bearing: 28 } });
  await e.dispatch({ type: 'setView', view: ${JSON.stringify(view)}, animate: false });
  const r = s.three.renderer;
  r.info.autoReset = false;
  return { buildings: w.buildings.length, unitMeters: w.unitMeters, view: s.viewMode(), flat: 1 - s.anchorHeightScale(), shadows: s.three.scene.children.some((c) => c.isDirectionalLight && c.castShadow) };
})()`;

/** Zeroes the accumulating counters and records the frame counter. */
const startProbe = `(() => {
  const s = window.__engine.scene, r = s.three.renderer;
  r.info.reset();
  return { f: s.frames(), t: performance.now(), src: s.activeSources() };
})()`;

const endProbe = `(() => {
  const s = window.__engine.scene, r = s.three.renderer, i = r.info.render;
  return { f: s.frames(), t: performance.now(), src: s.activeSources(), calls: i.calls, triangles: i.triangles, programs: r.info.programs ? r.info.programs.length : 0, geometries: r.info.memory.geometries, textures: r.info.memory.textures };
})()`;

async function runOnce(world, view) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const onEvent = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  listeners.add(onEvent);
  try {
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    // `pitch=0` keeps the playground from asking for a pitch the flat view would refuse.
    await send('Page.navigate', { url: `${origin}/index.html#panel=0&preset=realistic&tod=day&loc=external&labels=off&pitch=0&${world.hash}` }, sessionId);
    for (let i = 0; i < 600; i++) {
      if (await evaluate(sessionId, 'window.__MAPRAMA_READY__ === true')) break;
      await sleep(250);
    }
    const info = await evaluate(sessionId, setUp(view, world.dist), true);
    await sleep(SETTLE_MS);

    // ---- panning: the frame cost of a moving map ----
    const start = await evaluate(sessionId, startProbe);
    const cx = W / 2, cy = H / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    const until = Date.now() + SECONDS * 1000;
    let k = 0;
    while (Date.now() < until) {
      k++;
      const x = cx + Math.sin(k / 9) * 70, y = cy + Math.cos(k / 11) * 50;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, sessionId);
      await sleep(12);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
    const end = await evaluate(sessionId, endProbe);

    // ---- idle: the map is left alone ----
    await sleep(1500);
    const idleStart = await evaluate(sessionId, startProbe);
    await sleep(IDLE_SECONDS * 1000);
    const idleEnd = await evaluate(sessionId, endProbe);

    const frames = Math.max(1, end.f - start.f);
    const ms = end.t - start.t;
    return {
      info,
      frames,
      fps: frames / (ms / 1000),
      callsPerFrame: end.calls / frames,
      trisPerFrame: end.triangles / frames,
      geometries: end.geometries,
      textures: end.textures,
      idleFrames: idleEnd.f - idleStart.f,
      idleSources: idleEnd.src,
      errors,
    };
  } finally {
    listeners.delete(onEvent);
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const rows = [];
for (const world of WORLDS) {
  if (world.requires && !existsSync(world.requires)) {
    console.log(`skip ${world.name} (missing ${world.requires})`);
    continue;
  }
  for (const view of VIEWS) {
    const runs = [];
    for (let i = 0; i < REPEATS; i++) {
      const r = await runOnce(world, view);
      runs.push(r);
      console.log(
        `${world.name} | ${view} | run ${i + 1} | ${r.callsPerFrame.toFixed(0)} draw calls/frame, ` +
        `${Math.round(r.trisPerFrame).toLocaleString('en-US')} tris/frame, ${r.fps.toFixed(1)} fps while panning | ` +
        `idle ${r.idleFrames} frames [${r.idleSources.join(',')}]${r.errors.length ? ' | ERRORS: ' + r.errors.join(' ; ') : ''}`,
      );
    }
    rows.push({
      world: world.name,
      view,
      buildings: runs[0].info.buildings,
      callsPerFrame: Math.round(median(runs.map((r) => r.callsPerFrame))),
      trisPerFrame: Math.round(median(runs.map((r) => r.trisPerFrame))),
      fps: Number(median(runs.map((r) => r.fps)).toFixed(2)),
      idleFrames: Math.max(...runs.map((r) => r.idleFrames)),
      errors: runs.flatMap((r) => r.errors),
    });
  }
}

console.log('\n=== median of %d runs ===', REPEATS);
console.log('world                            | view  | draw calls/frame | triangles/frame | fps (panning, software GL) | idle frames');
for (const r of rows) {
  console.log(
    `${r.world.padEnd(32)} | ${r.view.padEnd(5)} | ${String(r.callsPerFrame).padStart(16)} | ${r.trisPerFrame.toLocaleString('en-US').padStart(15)} | ${r.fps.toFixed(2).padStart(26)} | ${String(r.idleFrames).padStart(11)}`,
  );
}
for (const world of new Set(rows.map((r) => r.world))) {
  const a = rows.find((r) => r.world === world && r.view === '2.5d');
  const b = rows.find((r) => r.world === world && r.view === '2d');
  if (!a || !b) continue;
  console.log(
    `\n${world}: 2D draws ${(a.callsPerFrame / b.callsPerFrame).toFixed(1)}× fewer calls ` +
    `(${a.callsPerFrame} → ${b.callsPerFrame}), ${(a.trisPerFrame / b.trisPerFrame).toFixed(1)}× fewer triangles ` +
    `(${a.trisPerFrame.toLocaleString('en-US')} → ${b.trisPerFrame.toLocaleString('en-US')}), and runs ` +
    `${(b.fps / a.fps).toFixed(1)}× faster while panning (${a.fps.toFixed(1)} → ${b.fps.toFixed(1)} fps).`,
  );
}
console.log('\n=== JSON ===');
console.log(JSON.stringify(rows, null, 2));

// A non-zero idle count is not a failure by itself — the procedural town's landmark spins forever,
// which is a property of that world and of both modes. What must never happen is the **flat** view
// idling worse than the tilted one it is supposed to be cheaper than.
const failed = rows.filter((r) => {
  if (r.errors.length) return true;
  if (r.view !== '2d') return false;
  const tilted = rows.find((o) => o.world === r.world && o.view === '2.5d');
  return r.idleFrames > (tilted ? tilted.idleFrames : 0);
});
ws.close();
server.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Chrome may still be flushing its profile */ }
if (failed.length) {
  for (const r of failed) console.error(`FAIL ${r.world} / ${r.view}: idle ${r.idleFrames} frames${r.errors.length ? ', ' + r.errors.join(' ; ') : ''}`);
  process.exit(1);
}
