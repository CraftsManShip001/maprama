// Idle-frame measurement harness: proves whether a static map really stops rendering.
//
//   node scripts/idle-frames.mjs [--repeats 2] [--seconds 10]
//
// Serves dev/ like scripts/screenshot.mjs, drives headless Chrome over CDP and,
// for each configuration, loads the dev sample world as a `data` WorldSource
// (`{ kind: 'data', world }`, exactly what an integrator passes), lets the scene
// settle, then counts `scene.frames()` over N seconds and reports
// `scene.activeSources()` at both ends.
//
// fps is derived from the frame-count delta only (the HUD's own fps field was
// unreliable once its ring buffer wrapped).
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const argNum = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const REPEATS = argNum('--repeats', 2);
const SECONDS = argNum('--seconds', 10);
const SETTLE_MS = argNum('--settle', 3000);
const W = 390, H = 760;

// theme knob: `realistic` has ambient traffic off, `urban` has it on
// the framing used by the `sample-*` screenshot scenarios, where the sample world's
// holo label cards are actually on screen (the plaza framing shows none)
const LABEL_CAM = { x: 0, z: 4, dist: 62, pitch: 42, bearing: 20 };
const PLAZA_CAM = null; // world.start (the plaza), dist 48, pitch 40, bearing 28
const CONFIGS = [];
for (const preset of ['realistic', 'urban']) {
  for (const labels of [{ key: 'labels off', spec: { enabled: false }, cam: PLAZA_CAM }, { key: 'labels on', spec: {}, cam: LABEL_CAM }]) {
    for (const rm of [false, true]) {
      CONFIGS.push({ name: `${preset} / ${labels.key} / ${rm ? 'reduce-motion' : 'no-reduce-motion'}`, preset, labels: labels.spec, cam: labels.cam, rm, pan: false });
    }
  }
}
// info cards: a card that is simply on screen must hold no active source, so a static map with
// cards up still draws 0 frames (the entrance transition releases its hold when it ends).
for (const cards of [1, 5]) {
  CONFIGS.push({ name: `realistic / ${cards} info card${cards > 1 ? 's' : ''} / no-reduce-motion`, preset: 'realistic', labels: { enabled: false }, cam: LABEL_CAM, rm: false, pan: false, cards });
}
CONFIGS.push({ name: 'realistic / 5 info cards + labels on / no-reduce-motion', preset: 'realistic', labels: {}, cam: LABEL_CAM, rm: false, pan: false, cards: 5 });

// panning reference (default config, no reduce motion)
CONFIGS.push({ name: 'realistic / labels off / no-reduce-motion / PANNING', preset: 'realistic', labels: { enabled: false }, rm: false, pan: true });
CONFIGS.push({ name: 'urban / labels off / no-reduce-motion / PANNING', preset: 'urban', labels: { enabled: false }, rm: false, pan: true });

const onlyIdx = argv.indexOf('--only');
if (onlyIdx >= 0) {
  const needle = argv[onlyIdx + 1];
  for (let i = CONFIGS.length - 1; i >= 0; i--) if (!CONFIGS[i].name.includes(needle)) CONFIGS.splice(i, 1);
}

// ---- playground bundle ----
await esbuild.build({
  entryPoints: [join(root, 'dev/main.ts')],
  outfile: join(root, 'dev/build/main.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], logLevel: 'warning',
});

// ---- static server ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.glb': 'model/gltf-binary' };
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const base = join(root, 'dev');
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(base, p));
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- chrome + CDP ----
const profile = mkdtempSync(join(tmpdir(), 'maprama-idle-'));
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
if (!port) { console.error('idle-frames: Chrome did not start\n' + chromeErr.slice(-2000)); process.exit(1); }
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

const initScript = (preset, labels, cam, cards = 0) => `(async () => {
  const world = await (await fetch('./sample-world.json')).json();
  const e = window.__engine;
  await e.dispatch({ type: 'init',
    world: { kind: 'data', world },
    theme: { base: ${JSON.stringify(preset)}, timeOfDay: 'day', zoomOut: 'keepGameView' },
    labels: ${JSON.stringify(labels)},
    ui: {},
    locationSource: 'external' });
  const s = e.scene, w = s.world();
  const cam = ${JSON.stringify(cam)};
  await e.dispatch({ type: 'setCamera', camera: {
    center: s.toLngLat(cam ? { x: cam.x, z: cam.z } : { x: w.start.x, z: w.start.z }),
    distance: (cam ? cam.dist : 48) * w.unitMeters,
    pitch: cam ? cam.pitch : 40,
    bearing: cam ? cam.bearing : 28 } });
  const cards = ${JSON.stringify(cards)};
  if (cards > 0) {
    const o = s.camera.orbit;
    // The sample world has 3 POIs; top the list up with building centroids so "5 cards" really is 5.
    const spots = [
      ...w.pois.map((p) => ({ id: p.id, name: p.name, cat: p.cat, x: p.x, z: p.z })),
      ...w.buildings.map((b, i) => ({ id: b.id, name: b.name || ('빌딩 ' + (i + 1)), cat: 'store', x: b.x, z: b.z })),
    ];
    const near = spots.sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z)).slice(0, cards);
    for (let i = 0; i < near.length; i++) {
      const p = near[i];
      await e.dispatch({ type: 'setInfoCard', card: {
        id: 'card-' + p.id,
        coordinate: s.toLngLat({ x: p.x, z: p.z }),
        anchor: 'auto',
        dismissible: true,
        content: {
          title: p.name,
          subtitle: '카페 · CAFE',
          icon: p.cat,
          badges: [{ text: '영업 중', tone: 'good' }],
          rating: { value: 4.3, count: 1281 },
          rows: [{ icon: 'hours', text: '22:00 영업 종료' }, { icon: 'location', text: '성수동2가 273-13' }],
          actions: [{ id: 'route', label: '길찾기', primary: true }, { id: 'call', label: '전화' }],
        },
      } });
    }
  }
  return { kind: w.kind, name: w.name, buildings: w.buildings.length, reduceMotion: s.reduceMotion, traffic: s.params().street.traffic, cards: document.querySelectorAll('.mpr-ic').length };
})()`;

async function runOnce(cfg) {
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
    // prefers-reduced-motion has to be emulated before the engine reads matchMedia at construction
    await send('Emulation.setEmulatedMedia', { features: cfg.rm ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] }, sessionId);
    await send('Page.navigate', { url: `${origin}/index.html#panel=0&layout=sample&preset=${cfg.preset}&loc=external&labels=off` }, sessionId);
    for (let i = 0; i < 600; i++) {
      if (await evaluate(sessionId, 'window.__MAPRAMA_READY__ === true')) break;
      await sleep(250);
    }
    const info = await evaluate(sessionId, initScript(cfg.preset, cfg.labels, cfg.cam, cfg.cards ?? 0), true);
    await sleep(SETTLE_MS);

    // a holo card is on screen exactly when its root is not display:none (the root is a
    // zero-size container whose dot / line / panel children are absolutely positioned)
    const holoProbe = `(() => { const all = [...document.querySelectorAll('.mpr-hl')]; const shown = all.filter((e) => e.style.display !== 'none'); return { built: all.length, shown: shown.length, ids: shown.map((e) => e.dataset.labelId) }; })()`;
    const holo = await evaluate(sessionId, holoProbe);
    const start = await evaluate(sessionId, `(() => { const s = window.__engine.scene; return { f: s.frames(), t: performance.now(), src: s.activeSources() }; })()`);
    if (cfg.pan) {
      // real pointer drag on the map container for the whole window
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
    } else {
      await sleep(SECONDS * 1000);
    }
    const end = await evaluate(sessionId, `(() => { const s = window.__engine.scene; return { f: s.frames(), t: performance.now(), src: s.activeSources() }; })()`);

    const frames = end.f - start.f;
    const ms = end.t - start.t;
    return { info, holo, frames, ms, per10s: Math.round((frames / ms) * 10000), srcStart: start.src, srcEnd: end.src, errors };
  } finally {
    listeners.delete(onEvent);
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

const results = [];
for (const cfg of CONFIGS) {
  for (let i = 0; i < REPEATS; i++) {
    const r = await runOnce(cfg);
    results.push({ cfg: cfg.name, run: i + 1, ...r });
    console.log(`${cfg.name} | run ${i + 1} | frames ${r.frames} in ${Math.round(r.ms)}ms (=${r.per10s}/10s, ${(r.frames / (r.ms / 1000)).toFixed(1)} fps) | activeSources start=[${r.srcStart.join(',')}] end=[${r.srcEnd.join(',')}] | world kind=${r.info.kind} rm=${r.info.reduceMotion} traffic=${r.info.traffic} cards=${r.info.cards ?? 0} holo=${r.holo.shown}/${r.holo.built}${r.holo.shown ? '(' + r.holo.ids.join(',') + ')' : ''}${r.errors.length ? ' | ERRORS: ' + r.errors.join(' ; ') : ''}`);
  }
}
console.log('\n=== JSON ===');
console.log(JSON.stringify(results, null, 1));

try { ws.close(); } catch {}
chrome.kill('SIGKILL');
server.close();
await sleep(200);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
