// Headless screenshot harness.
//
//   node scripts/screenshot.mjs              engine scenarios → .screenshots/<name>.png
//   node scripts/screenshot.mjs --reference  also captures the r128 prototype (needs network for its CDN three.js)
//   node scripts/screenshot.mjs --only town-urban-day,grid-toy-night
//
// Builds the playground bundle into dev/build/ (gitignored, served at /build/),
// serves dev/ (playground), dist/ at /dist/ and the
// repository's reference/preview at /reference/, drives Chrome through the
// DevTools protocol, waits for `window.__MAPRAMA_READY__`, and fails (exit 1)
// if an engine page logs a console error, throws, or never becomes ready.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const outDir = join(root, '.screenshots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const withReference = args.includes('--reference');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] || '').split(',')) : null;
const W = 390, H = 760;

const SCENARIOS = [
  { name: 'town-urban-day', hash: 'layout=town&preset=urban&tod=day&zo=keepGameView&dist=48&pitch=40' },
  { name: 'town-soft-day', hash: 'layout=town&preset=soft&tod=day&zo=keepGameView&dist=48&pitch=40' },
  { name: 'town-realistic-golden', hash: 'layout=town&preset=realistic&tod=golden&dist=48&pitch=40' },
  { name: 'grid-toy-night', hash: 'layout=grid&preset=toy&tod=night&dist=48&pitch=45' },
  { name: 'town-urban-dusk-mapcolors-110', hash: 'layout=town&preset=urban&tod=dusk&zo=mapColors&dist=110&pitch=40' },
  { name: 'town-urban-day-keepgameview-110', hash: 'layout=town&preset=urban&tod=day&zo=keepGameView&dist=110&pitch=40' },
  { name: 'sample-modern-day', hash: 'layout=sample&preset=modern&tod=day&dist=62&pitch=42&bearing=20&x=0&z=4' },
  // same sample world framed so the pond (water), Corner Park and the footbridge are all in view
  { name: 'sample-modern-day-features', hash: 'layout=sample&preset=modern&tod=day&dist=150&pitch=60&bearing=135&x=5&z=-2' },
  // part 2: labels, travel, drops (hash-driven playground scenarios, see dev/main.ts)
  { name: 'holo-labels-town-day', hash: 'layout=town&preset=urban&tod=day&labels=holo&icons=auto&dist=60&pitch=45&bearing=28&settle=1500' },
  { name: 'holo-labels-town-night', hash: 'layout=town&preset=urban&tod=night&labels=holo&icons=auto&dist=60&pitch=45&bearing=28&settle=1500' },
  { name: 'plane-mid-flight', hash: 'layout=town&preset=soft&tod=day&travel=plane&dist=50&pitch=48&bearing=28' },
  { name: 'subway-ghost-train', hash: 'layout=sample&preset=modern&tod=day&travel=subway&dist=40&pitch=50&bearing=20' },
  { name: 'drops-cd-beams', hash: 'layout=town&preset=urban&tod=dusk&drops=cd&dist=26&pitch=42&bearing=28&settle=800' },
  // the other label styles (holo is covered above)
  { name: 'labels-app-town-day', hash: 'layout=town&preset=urban&tod=day&labels=app&dist=60&pitch=45&bearing=28&settle=1200' },
  { name: 'labels-minimal-town-day', hash: 'layout=town&preset=urban&tod=day&labels=minimal&dist=60&pitch=45&bearing=28&settle=1200' },
  { name: 'labels-clean-town-day', hash: 'layout=town&preset=urban&tod=day&labels=clean&dist=60&pitch=45&bearing=28&settle=1200' },
  { name: 'labels-sticker-town-day', hash: 'layout=town&preset=urban&tod=day&labels=sticker&dist=60&pitch=45&bearing=28&settle=1200' },
  { name: 'labels-ground-town-day', hash: 'layout=town&preset=urban&tod=day&labels=ground&dist=45&pitch=50&bearing=28&settle=800' },
  { name: 'labels-sign-town-day', hash: 'layout=town&preset=urban&tod=day&labels=sign&dist=40&pitch=42&bearing=28&settle=800' },
  // location puck just above the scale bar: shown while clear of it, hidden once its projected marker would overlap
  { name: 'puck-hud-far-clear', hash: 'layout=town&preset=urban&tod=day&ui=1&player=1&dist=110&pitch=45&bearing=0&x=-19.49&z=-51.3&settle=300' },
  { name: 'puck-hud-far', hash: 'layout=town&preset=urban&tod=day&ui=1&player=1&dist=110&pitch=45&bearing=0&x=-19.49&z=-55.13&settle=300' },
  { name: 'puck-hud-close', hash: 'layout=town&preset=urban&tod=day&ui=1&player=1&dist=14&pitch=45&bearing=0&x=-28.88&z=-23.59&settle=300' },
  // real GLB (offline CC0 fixture from scripts/make-glb-fixture.mjs) loaded as the player character
  { name: 'glb-character-town-day', hash: 'layout=town&preset=soft&tod=day&player=1&model=/fixtures/box-character.glb&dist=12&pitch=30&bearing=28&settle=500' },
  { name: 'sample-labels-custom-ui', hash: 'layout=sample&preset=modern&tod=day&labels=holo&content=custom&ui=1&player=1&dist=62&pitch=42&bearing=20&x=0&z=4&settle=1500' },
  // real OSM sample produced by tools/osm (read-only; skipped when absent)
  { name: 'seongsu-urban-day', hash: 'layout=sample&world=/osm-samples/seongsu.world.json&preset=urban&tod=day&dist=60&pitch=45', requires: join(repo, 'tools/osm/samples/seongsu.world.json') },
];
// dist/engine.html driven through the WebView transport (window 'message' events), like react-native-webview
const HTML_SCENARIOS = [
  { name: 'engine-html-town-modern-golden', init: { type: 'init', world: { kind: 'procedural', layout: 'town' }, theme: { base: 'modern', timeOfDay: 'golden' }, labels: {}, ui: {}, locationSource: 'simulated', camera: { distance: 400, pitch: 45, bearing: 28 } } },
];
const htmlSetup = (init) => `(() => {
  window.ReactNativeWebView = { postMessage(d) { const m = JSON.parse(d).msg; if (m.type === 'error') console.error('engine error [' + m.code + '] ' + m.message); } };
  window.postMessage(JSON.stringify({ v: 1, seq: 0, kind: 'cmd', msg: ${JSON.stringify(init)} }), '*');
  const e = window.__maprama;
  // Rendering is on demand: hold an active source while waiting for the 24 settle frames.
  const wait = () => { const s = e.scene; if (s && s.world()) { const release = s.addActiveSource('screenshot'); const need = s.frames() + 24; const off = s.onFrame(() => { if (s.frames() >= need) { off(); release(); window.__MAPRAMA_READY__ = true; } }); } else setTimeout(wait, 100); };
  wait();
})()`;
const REFERENCES = [
  { name: 'reference-town-urban-day', hash: 'layout=town&map=1&preset=urban&zo=game&tod=day&dist=48' },
  { name: 'reference-town-soft-day', hash: 'preset=soft&layout=town&map=1&zo=game&dist=48' },
  { name: 'reference-town-realistic-golden', hash: 'layout=town&preset=realistic&tod=golden&dist=48' },
  { name: 'reference-grid-toy-night', hash: 'layout=grid&preset=toy&tod=night&dist=48' },
  { name: 'reference-town-urban-dusk-map-110', hash: 'layout=town&map=1&preset=urban&zo=map&tod=dusk&dist=110' },
];

// ---- playground bundle ----
await esbuild.build({
  entryPoints: [join(root, 'dev/main.ts')],
  outfile: join(root, 'dev/build/main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'warning',
});

// ---- static server ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.map': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let base = join(root, 'dev');
  if (p.startsWith('/dist/')) { base = join(root, 'dist'); p = p.slice('/dist'.length); }
  else if (p.startsWith('/reference/')) { base = join(repo, 'reference/preview'); p = p.slice('/reference'.length); }
  else if (p.startsWith('/osm-samples/')) { base = join(repo, 'tools/osm/samples'); p = p.slice('/osm-samples'.length); }
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(base, p));
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- chrome + CDP ----
const profile = mkdtempSync(join(tmpdir(), 'maprama-shot-'));
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
if (!port) { console.error('screenshot: Chrome did not start\n' + chromeErr.slice(-2000)); await cleanup(); process.exit(1); }
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

async function capture({ name, url, strict, clipSelector, waitReady, settleMs, setup }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const onEvent = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('exception: ' + (d.exception?.description || d.text));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push('log: ' + m.params.entry.text + (m.params.entry.url ? ` (${m.params.entry.url})` : ''));
    }
  };
  listeners.add(onEvent);
  const started = Date.now();
  try {
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    const vw = clipSelector ? 1280 : W, vh = clipSelector ? 1000 : H;
    await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    if (setup) {
      for (let i = 0; i < 300; i++) {
        const r = await send('Runtime.evaluate', { expression: "document.readyState === 'complete' && !!window.__maprama", returnByValue: true }, sessionId);
        if (r.result.value === true) break;
        await sleep(100);
      }
      await send('Runtime.evaluate', { expression: setup }, sessionId);
    }
    let ready = false;
    const deadline = Date.now() + 180000;
    if (waitReady) {
      while (Date.now() < deadline) {
        const r = await send('Runtime.evaluate', { expression: 'window.__MAPRAMA_READY__ === true', returnByValue: true }, sessionId);
        if (r.result.value === true) { ready = true; break; }
        if (errors.length && strict) break;
        await sleep(500);
      }
    } else {
      await sleep(settleMs || 12000);
      ready = true;
    }
    if (!ready) errors.push(`page did not become ready in time`);
    let clip;
    if (clipSelector) {
      const r = await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(clipSelector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const b = el.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height, scale: 1 }; })()`, returnByValue: true }, sessionId);
      clip = r.result.value || undefined;
      await sleep(500);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: !!clip }, sessionId);
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (errors.length) {
      console[strict ? 'error' : 'warn'](`${strict ? 'FAIL' : 'warn'} ${name} (${secs}s) → ${file}\n  ${errors.join('\n  ')}`);
    } else console.log(`ok   ${name} (${secs}s) → ${file}`);
    return !strict || errors.length === 0;
  } finally {
    listeners.delete(onEvent);
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function cleanup() {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}

mkdirSync(outDir, { recursive: true });
let ok = true;
try {
  for (const s of SCENARIOS) {
    if (only && !only.has(s.name)) continue;
    if (s.requires && !existsSync(s.requires)) { console.warn(`skip ${s.name}: ${s.requires} not found`); continue; }
    ok = (await capture({ name: s.name, url: `${origin}/index.html#panel=0&${s.hash}`, strict: true, waitReady: true })) && ok;
  }
  for (const s of HTML_SCENARIOS) {
    if (only && !only.has(s.name)) continue;
    ok = (await capture({ name: s.name, url: `${origin}/dist/engine.html`, strict: true, waitReady: true, setup: htmlSetup(s.init) })) && ok;
  }
  if (withReference) {
    for (const s of REFERENCES) {
      if (only && !only.has(s.name)) continue;
      await capture({ name: s.name, url: `${origin}/reference/preview.html#${s.hash}`, strict: false, clipSelector: '#screen', waitReady: false, settleMs: 15000 });
    }
  }
} catch (e) {
  console.error('screenshot: ' + (e?.stack || e));
  ok = false;
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
