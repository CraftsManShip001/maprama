// Headless check of the built docs site (run `npm run build` first).
//
//   node scripts/screenshot.mjs [--out <dir>] [--only playground,home]
//
// Serves .vitepress/dist on 127.0.0.1 (clean URLs), drives headless Chrome over
// the DevTools protocol (SwiftShader WebGL), waits for
// `window.__DIORAMA_PLAYGROUND_READY__`, runs the page's scenario and writes a
// PNG per page. Scenarios:
//   labels  holo label cards become visible after `labelsIndex`;
//   travel  a walk → car → walk trip emits `travel:start`, the player moves
//           (captured mid-route), then `travel:arrive` arrives;
//   drops   the demo layer renders 8 drops with rarity beams/rings, and the JSX
//           panel for `source="service"` includes `userId` and only props that
//           exist in `@diorama/react-native`.
// Exits 1 when a page logs a console error, throws, logs a browser error
// entry, shows an `unsupported` note, fails its scenario, or never becomes
// ready. Chrome and the server are always shut down before exit.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(docs, '.vitepress', 'dist');
const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = argOf('--out') ?? join(docs, '.screenshots');
const only = argOf('--only') ? new Set(argOf('--only').split(',')) : null;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_TIMEOUT_MS = 120000;

const PAGES = [
  { name: 'playground', path: '/playground/', width: 1280, height: 1500, clickTravel: true },
  { name: 'home', path: '/', width: 1280, height: 900 },
  // real OSM sample (ODbL) served from docs/public/worlds through a `url` world source
  { name: 'playground-seongsu', path: '/playground/', width: 1280, height: 1000, world: 'seongsu' },
  { name: 'playground-mobile', path: '/playground/', width: 400, height: 900 },
  { name: 'playground-labels', path: '/playground/', width: 1280, height: 900, scenario: 'labels' },
  { name: 'playground-travel', path: '/playground/', width: 1280, height: 900, scenario: 'travel' },
  { name: 'playground-drops', path: '/playground/', width: 1280, height: 1500, scenario: 'drops' },
];

// Props per component, from packages/react-native/src/types.ts (DioramaMapProps + ref,
// CharacterProps, DataDropLayerProps | ServiceDropLayerProps). The JSX panel may only use these.
const RN_PROPS = {
  DioramaMap: ['ref', 'key', 'world', 'theme', 'labels', 'ui', 'camera', 'location', 'engine', 'requestTimeoutMs', 'travelStartTimeoutMs', 'onReady', 'onPress', 'onBuildingPress', 'onError', 'style', 'testID'],
  Character: ['key', 'id', 'isPlayer', 'model', 'animations', 'follow', 'position', 'name', 'color', 'scale', 'showNameTag'],
  DropLayer: ['key', 'id', 'collectRadiusMeters', 'collectorIds', 'onCollect', 'source', 'data', 'getId', 'getCoordinate', 'getType', 'getRarity', 'getValue', 'getModel', 'getPayload',
    'channel', 'apiKey', 'baseUrl', 'userId', 'radiusMeters', 'refetchDistanceMeters', 'characterId', 'positionThrottleMs', 'onCollectVerified', 'onCollectRejected'],
};

/** Attribute names used on each RN component in a JSX snippet (braced expressions and strings removed first). */
function jsxProps(src) {
  let s = src.replace(/"[^"\n]*"/g, '""');
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/\{[^{}]*\}/g, ''); }
  const out = [];
  for (const m of s.matchAll(/<(DioramaMap|Character|DropLayer)\b([^>]*)>/g)) {
    for (const a of m[2].matchAll(/([A-Za-z]+)(?==|\s|\/|$)/g)) out.push([m[1], a[1]]);
  }
  return out;
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('screenshot: .vitepress/dist is missing; run `npm run build` first');
  process.exit(1);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  let file = normalize(join(dist, p));
  if (!extname(file) && existsSync(file + '.html')) file += '.html';
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'diorama-docs-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
async function cleanup() {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}

let port = 0;
for (let i = 0; i < 200 && !port; i++) {
  const f = join(profile, 'DevToolsActivePort');
  if (existsSync(f)) port = Number(readFileSync(f, 'utf8').split('\n')[0]);
  else await sleep(100);
}
if (!port) { console.error('screenshot: Chrome did not start\n' + chromeErr.slice(-2000)); await cleanup(); process.exit(1); }

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
ws = new WebSocket(version.webSocketDebuggerUrl);
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
const evaluate = async (expression, sessionId) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

/** Polls `expression` until it is truthy (returns its value) or `timeoutMs` passes (returns null). */
async function waitFor(expression, sessionId, timeoutMs, stepMs = 250) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await evaluate(expression, sessionId);
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(stepMs);
  }
}

const PG = 'window.__dioramaPlayground';
/** Meters between the player's start and latest reported position. */
const MOVED = `(() => { const p = ${PG}.probe; if (!p.position || !p.start) return 0;
  const k = 111320, dx = (p.position.lng - p.start.lng) * k * Math.cos(p.start.lat * Math.PI / 180), dz = (p.position.lat - p.start.lat) * k;
  return Math.round(Math.hypot(dx, dz)); })()`;
const JSX_TEXT = `document.querySelector('.dio-pg .code pre')?.textContent || ''`;

function checkJsx(jsx) {
  const bad = jsxProps(jsx).filter(([c, p]) => !RN_PROPS[c].includes(p)).map(([c, p]) => `${c}.${p}`);
  return bad.length ? `JSX uses props that @diorama/react-native does not have: ${bad.join(', ')}` : null;
}

const SCENARIOS = {
  async labels(sessionId) {
    const visible = await waitFor(`document.querySelectorAll('.dio-pg .dio-hl.on').length`, sessionId, 20000);
    const index = await evaluate(`${PG}.probe.events.labelsIndex || 0`, sessionId);
    if (!index) return { error: 'no labelsIndex event' };
    if (!visible) return { error: 'no holo label card became visible', info: { labelsIndex: index } };
    await sleep(800); // let the dot → line → panel pop-in finish
    const titles = await evaluate(`[...document.querySelectorAll('.dio-pg .dio-hl.on b')].slice(0, 6).map((b) => b.textContent)`, sessionId);
    return { info: { labelsIndex: index, holoVisible: visible, titles } };
  },

  async travel(sessionId) {
    const target = await evaluate(`(() => {
      const pg = ${PG}, s = pg.engine.scene, w = s.world(), st = w.start;
      const c = w.graph.nodes.map((n) => ({ n, d: Math.hypot(n.x - st.x, n.z - st.z) })).filter((o) => o.d > 22 && o.d < 40).sort((a, b) => a.d - b.d)[0];
      if (!c) return null;
      pg.state.distance = 64;
      pg.transport.postCommand({ type: 'setCamera', camera: { follow: 'me' } });
      pg.travelTo(s.toLngLat({ x: c.n.x, z: c.n.z }));
      return { targetUnits: Math.round(c.d), modes: [...pg.state.travelModes] };
    })()`, sessionId);
    if (!target) return { error: 'no road node 22-40 world units from the start' };
    if (!(await waitFor(`(${PG}.probe.events['travel:start'] || 0) > 0`, sessionId, 20000))) return { error: 'no travel:start event', info: target };
    const mid = await waitFor(`(() => { const m = ${MOVED}; return m > 40 && !(${PG}.probe.events['travel:arrive'] > 0) ? m : 0; })()`, sessionId, 90000);
    if (!mid) return { error: 'the player did not move 40 m before arriving', info: target };
    return {
      info: { ...target, travelStart: true, movedMetersAtShot: mid },
      after: async () => {
        const arrived = await waitFor(`(${PG}.probe.events['travel:arrive'] || 0) > 0`, sessionId, 240000, 500);
        const moved = await evaluate(MOVED, sessionId);
        return arrived ? { info: { travelArrive: true, movedMeters: moved } } : { error: `no travel:arrive event (moved ${moved} m)` };
      },
    };
  },

  async drops(sessionId) {
    const dataJsxError = checkJsx(await evaluate(JSX_TEXT, sessionId));
    if (dataJsxError) return { error: dataJsxError };
    await evaluate(`${PG}.state.distance = 28`, sessionId);
    const stats = await waitFor(`(() => {
      const g = ${PG}.engine.scene.groups.dynamic.getObjectByName('drops');
      if (!g || g.children.length < 8) return null;
      let additive = 0; g.traverse((o) => { if (o.isMesh && o.material && o.material.blending === 2) additive++; });
      return additive > 0 ? { dropObjects: g.children.length, additiveFxMeshes: additive } : null;
    })()`, sessionId, 20000);
    if (!stats) return { error: 'the drop layer did not render 8 drops with rarity fx' };
    await sleep(2500); // appear animation: the beam grows from the ground
    await evaluate(`${PG}.state.dropSource = 'service'`, sessionId);
    await sleep(400);
    const jsx = await evaluate(JSX_TEXT, sessionId);
    const missing = ['source="service"', 'userId={userId}', 'channel=', 'apiKey=', 'baseUrl=', 'onCollectVerified', 'onCollectRejected'].filter((s) => !jsx.includes(s));
    if (missing.length) return { error: `service JSX is missing ${missing.join(', ')}`, info: stats };
    const serviceJsxError = checkJsx(jsx);
    if (serviceJsxError) return { error: serviceJsxError, info: stats };
    const state = await evaluate(`({ type: ${PG}.state.dropType, rarity: ${PG}.state.dropRarity, collects: ${PG}.probe.events['drop:collect'] || 0 })`, sessionId);
    return { info: { ...stats, ...state, serviceJsx: 'userId + props ok' } };
  },
};

async function capture(page) {
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
    await send('Emulation.setDeviceMetricsOverride', { width: page.width, height: page.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: origin + page.path }, sessionId);
    let ready = false;
    const deadline = Date.now() + PAGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await evaluate('window.__DIORAMA_PLAYGROUND_READY__ === true', sessionId)) === true) { ready = true; break; }
      if (errors.length) break;
      await sleep(500);
    }
    if (ready && page.world) {
      // switch the playground world through its reactive state and wait for the new world to render
      await evaluate(`window.__dioramaPlayground.state.world = ${JSON.stringify(page.world)}`, sessionId);
      await sleep(500);
      ready = false;
      while (Date.now() < deadline) {
        if ((await evaluate('window.__DIORAMA_PLAYGROUND_READY__ === true', sessionId)) === true) { ready = true; break; }
        if (errors.length) break;
        await sleep(500);
      }
    }
    if (!ready) errors.push('page did not become ready in time');
    let info = {};
    let after = null;
    if (ready && page.clickTravel) {
      await evaluate("document.querySelector('[data-action=travel]')?.click()", sessionId);
      await sleep(2500);
    }
    if (ready && page.scenario && !errors.length) {
      const r = await SCENARIOS[page.scenario](sessionId);
      if (r.error) errors.push(`scenario ${page.scenario}: ${r.error}`);
      info.scenario = r.info;
      after = r.after ?? null;
    }
    if (ready) {
      Object.assign(info, await evaluate(`({
        unsupported: [...document.querySelectorAll('[data-unsupported]')].map((e) => e.dataset.unsupported),
        log: [...document.querySelectorAll('.dio-pg .log li')].map((e) => e.textContent),
        canvas: !!document.querySelector('.dio-pg canvas'),
        map: (() => { const r = document.querySelector('.dio-pg .map')?.getBoundingClientRect(); return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null; })(),
        jsx: (document.querySelector('.dio-pg .code pre')?.textContent || '').split('\\n').length,
      })`, sessionId));
      if (info.unsupported.length) errors.push(`unsupported notes shown: ${info.unsupported.join(', ')}`);
      await sleep(300);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `docs-${page.name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    if (after && !errors.length) {
      const r = await after();
      if (r.error) errors.push(`scenario ${page.scenario} (after screenshot): ${r.error}`);
      info.after = r.info;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (errors.length) console.error(`FAIL ${page.name} (${secs}s) → ${file}\n  ${errors.join('\n  ')}`);
    else console.log(`ok   ${page.name} (${secs}s) → ${file} ${JSON.stringify(info)}`);
    return errors.length === 0;
  } finally {
    listeners.delete(onEvent);
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

let ok = true;
try {
  for (const page of PAGES) {
    if (only && !only.has(page.name)) continue;
    ok = (await capture(page)) && ok;
  }
} catch (e) {
  console.error('screenshot: ' + (e?.stack || e));
  ok = false;
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
