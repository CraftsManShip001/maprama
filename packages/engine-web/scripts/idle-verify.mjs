// Sanity check for idle-frames.mjs: proves the idle scene is actually drawn
// (non-blank canvas, frames() already > 0) while its 30 s frame delta is 0.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 390, H = 760;
const SECONDS = Number(process.argv[2] || 30);

await esbuild.build({ entryPoints: [join(root, 'dev/main.ts')], outfile: join(root, 'dev/build/main.js'), bundle: true, format: 'esm', platform: 'browser', target: ['es2020'], logLevel: 'warning' });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const base = join(root, 'dev');
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(base, p));
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'maprama-verify-'));
const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--window-size=${W},${H}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let port = 0;
for (let i = 0; i < 200 && !port; i++) { const f = join(profile, 'DevToolsActivePort'); if (existsSync(f)) port = Number(readFileSync(f, 'utf8').split('\n')[0]); else await sleep(100); }
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const ev = async (s, e, aw = false) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
await send('Page.navigate', { url: `${origin}/index.html#panel=0&layout=sample&preset=realistic&loc=external&labels=off` }, sessionId);
for (let i = 0; i < 600; i++) { if (await ev(sessionId, 'window.__MAPRAMA_READY__ === true')) break; await sleep(250); }
const info = await ev(sessionId, `(async () => {
  const world = await (await fetch('./sample-world.json')).json();
  const e = window.__engine;
  await e.dispatch({ type: 'init', world: { kind: 'data', world }, theme: { base: 'realistic', timeOfDay: 'day', zoomOut: 'keepGameView' }, labels: {}, ui: {}, locationSource: 'external' });
  const s = e.scene, w = s.world();
  await e.dispatch({ type: 'setCamera', camera: { center: s.toLngLat({ x: 0, z: 4 }), distance: 62 * w.unitMeters, pitch: 42, bearing: 20 } });
  const p = s.params();
  return { kind: w.kind, buildings: w.buildings.length, reduceMotion: s.reduceMotion, traffic: p.street.traffic, labels: JSON.stringify(s.labels()) };
})()`, true);
await sleep(3000);
const start = await ev(sessionId, `(() => { const s = window.__engine.scene; return { f: s.frames(), t: performance.now(), src: s.activeSources() }; })()`);
const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync(join(root, '.idle-verify.png'), Buffer.from(shot.data, 'base64'));
// distinct-colour count straight off the WebGL canvas (a blank/black canvas gives 1)
const pixels = await ev(sessionId, `(() => { const all=[...document.querySelectorAll('.mpr-hl')]; const dbg = all.map(e=>({id:e.dataset.labelId, d:e.style.display, op:getComputedStyle(e).opacity, r:JSON.stringify(e.getBoundingClientRect())})); console.log('DBG',JSON.stringify(dbg)); window.__dbg=dbg; const vis=all.filter(e=>{const st=getComputedStyle(e); const r=e.getBoundingClientRect(); return st.visibility!=='hidden' && st.display!=='none' && Number(st.opacity)>0.05 && r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight;}); return { holoCards: all.length, visibleHolo: vis.length, dbg: dbg.slice(0,12), camDist: window.__engine.scene.camera.orbit.distance, unit: window.__engine.scene.world().unitMeters }; })()`); void await ev(sessionId, `(() => {
  const c = document.querySelector('canvas');
  const g = c.getContext('webgl2') || c.getContext('webgl');
  const px = new Uint8Array(c.width * c.height * 4);
  g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
  const set = new Set();
  for (let i = 0; i < px.length; i += 4 * 97) set.add(px[i] + ',' + px[i+1] + ',' + px[i+2]);
  return { w: c.width, h: c.height, distinctColours: set.size };
})()`);
await sleep(SECONDS * 1000);
const end = await ev(sessionId, `(() => { const s = window.__engine.scene; return { f: s.frames(), t: performance.now(), src: s.activeSources() }; })()`);
console.log(JSON.stringify({ info, pixels, framesAtSettle: start.f, framesDelta: end.f - start.f, overMs: Math.round(end.t - start.t), srcStart: start.src, srcEnd: end.src }, null, 1));
try { ws.close(); } catch {}
chrome.kill('SIGKILL'); server.close(); await sleep(200); rmSync(profile, { recursive: true, force: true });
process.exit(0);
