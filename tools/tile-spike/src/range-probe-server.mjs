/**
 * HTTP Range probe: a throwaway origin + two "CDN" servers and a page that runs
 * range requests from whatever engine loads it (mobile Safari / WKWebView /
 * react-native-webview / React Native's own `fetch`).
 *
 * Why this exists: the whole PMTiles plan rests on `Range: bytes=a-b` working in
 * React Native. This lets us check it instead of assuming it.
 *
 *   node src/range-probe-server.mjs [--host 0.0.0.0]
 *
 * Ports:
 *   8791  origin      serves /probe.html and /blob.bin (same origin as the page)
 *   8792  cdn-ok      cross origin, full CORS: preflight allows `Range`, exposes
 *                     `Content-Range`/`Content-Length`/`ETag`/`Accept-Ranges`
 *   8793  cdn-narrow  cross origin, `Access-Control-Allow-Origin: *` only — no
 *                     `Access-Control-Allow-Headers`, no exposed headers
 *
 * Every request is logged with its Range header. The page POSTs its results to
 * the origin's /report, which prints them, so results can be read from the
 * server log rather than off a device screen.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeTile } from './payload.mjs';
import { worldToGeo, tileFeatures } from './tiler.mjs';

/** One real tile from the checked-in Seongsu sample, gzipped as PMTiles stores it. */
const SAMPLE_TILE_GZ = (() => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const world = JSON.parse(readFileSync(join(repo, 'tools', 'osm', 'samples', 'seongsu.world.json'), 'utf8'));
  const { tiles } = tileFeatures(worldToGeo(world), 15, { extent: 8192, buffer: 256 });
  const biggest = [...tiles.values()].sort((a, b) => b.layers.buildings.length - a.layers.buildings.length)[0];
  return gzipSync(encodeTile({ extent: 8192, buffer: 256, attribution: [0], layers: biggest.layers }), { level: 9 });
})();

const BLOB_SIZE = 8 * 1024 * 1024;

/** Deterministic 8 MiB body; byte i is `(i * 31 + 7) % 251`. */
const BLOB = Buffer.alloc(BLOB_SIZE);
for (let i = 0; i < BLOB_SIZE; i++) BLOB[i] = (i * 31 + 7) % 251;
const ETAG = `"${createHash('sha256').update(BLOB).digest('hex').slice(0, 16)}"`;

const args = process.argv.slice(2);
const hostIdx = args.indexOf('--host');
const HOST = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';

/** Parses a single-range `Range` header. Returns null when absent/unsatisfiable. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const len = Math.min(Number(b), size);
    return { start: size - len, end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}

function log(tag, req, extra = '') {
  const range = req.headers.range ? `Range: ${req.headers.range}` : 'Range: -';
  console.log(`[${tag}] ${req.method} ${req.url}  ${range}  Origin: ${req.headers.origin ?? '-'} ${extra}`);
}

function serveBlob(tag, req, res, cors) {
  const range = parseRange(req.headers.range, BLOB_SIZE);
  const head = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: ETAG,
    'Cache-Control': 'no-store',
    ...cors,
  };
  if (!range) {
    log(tag, req, '-> 200 full');
    res.writeHead(200, { ...head, 'Content-Length': String(BLOB_SIZE) });
    res.end(req.method === 'HEAD' ? undefined : BLOB);
    return;
  }
  const body = BLOB.subarray(range.start, range.end + 1);
  log(tag, req, `-> 206 ${range.start}-${range.end} (${body.length} B)`);
  res.writeHead(206, {
    ...head,
    'Content-Range': `bytes ${range.start}-${range.end}/${BLOB_SIZE}`,
    'Content-Length': String(body.length),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** cdn-ok: everything a PMTiles client needs across origins. */
const CORS_OK = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
};
/** cdn-narrow: the common misconfiguration — allow-origin only. */
const CORS_NARROW = { 'Access-Control-Allow-Origin': '*' };

function makeCdn(tag, cors, allowRangeHeader) {
  return createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      const head = { ...cors };
      if (allowRangeHeader) {
        head['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
        head['Access-Control-Allow-Headers'] = 'Range';
        head['Access-Control-Max-Age'] = '0';
      }
      log(tag, req, `-> 204 preflight (allowRangeHeader=${allowRangeHeader})`);
      res.writeHead(204, head);
      res.end();
      return;
    }
    serveBlob(tag, req, res, cors);
  });
}

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Range probe</title>
<style>body{font:13px -apple-system,system-ui,sans-serif;margin:8px}
li{margin:4px 0}.ok{color:#0a0}.bad{color:#c00}pre{white-space:pre-wrap;font-size:11px}</style>
<h3>HTTP Range probe</h3><ul id="out"></ul><pre id="raw"></pre>
<script>
const ORIGIN = location.origin;
const CDN_OK = ORIGIN.replace(/:\\d+$/, ':8792');
const CDN_NARROW = ORIGIN.replace(/:\\d+$/, ':8793');
const results = [];
const out = document.getElementById('out');
function expectedByte(i){ return (i * 31 + 7) % 251; }
function add(name, ok, detail){
  results.push({ name, ok, detail });
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'bad';
  li.textContent = (ok ? 'PASS ' : 'FAIL ') + name + ' — ' + detail;
  out.appendChild(li);
}
async function rangeTest(name, url, header){
  try {
    const res = await fetch(url, { headers: { Range: header }, cache: 'no-store' });
    const buf = new Uint8Array(await res.arrayBuffer());
    const cr = res.headers.get('Content-Range');
    let bodyOk = 'n/a';
    const m = /^bytes=(\\d+)-/.exec(header);
    if (m) {
      const start = Number(m[1]);
      bodyOk = buf.length > 0 && buf[0] === expectedByte(start) && buf[buf.length - 1] === expectedByte(start + buf.length - 1)
        ? 'bytes match' : 'BYTES MISMATCH';
    }
    const ok = res.status === 206 && buf.length < 8 * 1024 * 1024 && bodyOk !== 'BYTES MISMATCH';
    add(name, ok, 'status=' + res.status + ' len=' + buf.length + ' Content-Range=' + (cr ?? 'null') + ' ' + bodyOk);
  } catch (e) {
    add(name, false, 'threw: ' + (e && e.message ? e.message : String(e)));
  }
}
(async () => {
  add('ua', true, navigator.userAgent);
  await rangeTest('same-origin bytes=1000-1099', ORIGIN + '/blob.bin', 'bytes=1000-1099');
  await rangeTest('same-origin bytes=4194304-4194559', ORIGIN + '/blob.bin', 'bytes=4194304-4194559');
  await rangeTest('same-origin suffix bytes=-127', ORIGIN + '/blob.bin', 'bytes=-127');
  await rangeTest('cross-origin CORS ok bytes=2048-2175', CDN_OK + '/blob.bin', 'bytes=2048-2175');
  await rangeTest('cross-origin CORS narrow (expect FAIL)', CDN_NARROW + '/blob.bin', 'bytes=2048-2175');
  // PMTiles stores tiles gzipped; the client has to gunzip them itself.
  try {
    const res = await fetch(ORIGIN + '/tile.gz', { headers: { Range: 'bytes=0-1000000' }, cache: 'no-store' });
    const gz = await res.arrayBuffer();
    let plain;
    if (typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      plain = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer());
    } else {
      throw new Error('no DecompressionStream');
    }
    const magic = String.fromCharCode(plain[0], plain[1], plain[2], plain[3]);
    add('gunzip a ranged MTIL tile', magic === 'MTIL',
      'DecompressionStream=' + typeof DecompressionStream + ' gz=' + gz.byteLength + ' plain=' + plain.length + ' magic=' + magic);
  } catch (e) { add('gunzip a ranged MTIL tile', false, 'threw: ' + (e && e.message ? e.message : String(e))); }

  // The engine WebView is an inline document (source={{ html }}), i.e. an opaque
  // origin that sends "Origin: null". A srcdoc iframe reproduces that here.
  await new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.srcdoc = '<script>(async()=>{const r={};' +
      'try{const res=await fetch("' + CDN_OK + '/blob.bin",{headers:{Range:"bytes=2048-2175"},cache:"no-store"});' +
      'const b=await res.arrayBuffer();r.status=res.status;r.len=b.byteLength;r.cr=res.headers.get("Content-Range");}' +
      'catch(e){r.err=String(e&&e.message||e);}' +
      'parent.postMessage(JSON.stringify(r),"*");})();<\\/script>';
    const done = (ev) => {
      window.removeEventListener('message', done);
      clearTimeout(timer);
      let r = {};
      try { r = JSON.parse(ev.data); } catch { r = { err: 'bad reply' }; }
      add('opaque-origin (srcdoc) cross-origin range', r.status === 206 && r.len === 128,
        r.err ? 'threw: ' + r.err : 'status=' + r.status + ' len=' + r.len + ' Content-Range=' + r.cr);
      f.remove();
      resolve();
    };
    const timer = setTimeout(() => { add('opaque-origin (srcdoc) cross-origin range', false, 'timed out'); f.remove(); resolve(); }, 5000);
    window.addEventListener('message', done);
    document.body.appendChild(f);
  });
  // concurrency: 8 ranges at once, as a tile client would
  const t0 = performance.now();
  try {
    const parts = await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const s = 100000 + i * 5000;
      return fetch(ORIGIN + '/blob.bin', { headers: { Range: 'bytes=' + s + '-' + (s + 4999) }, cache: 'no-store' })
        .then(r => r.arrayBuffer().then(b => ({ status: r.status, len: b.byteLength })));
    }));
    const allOk = parts.every(p => p.status === 206 && p.len === 5000);
    add('8 concurrent ranges', allOk, parts.map(p => p.status + '/' + p.len).join(' ') + ' in ' + Math.round(performance.now() - t0) + ' ms');
  } catch (e) { add('8 concurrent ranges', false, 'threw: ' + e.message); }
  document.getElementById('raw').textContent = JSON.stringify(results, null, 1);
  try { await fetch(ORIGIN + '/report', { method: 'POST', body: JSON.stringify(results) }); } catch {}
})();
</script>`;

const origin = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log('\n==== PROBE REPORT ====');
      try {
        for (const r of JSON.parse(body)) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
      } catch {
        console.log(body);
      }
      console.log('==== END REPORT ====\n');
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
    return;
  }
  if (url.pathname === '/blob.bin') return serveBlob('origin', req, res, { 'Access-Control-Allow-Origin': '*' });
  if (url.pathname === '/tile.gz') {
    // a real gzipped MTIL tile, so the device proves it can decompress one
    log('origin', req, '-> 200 tile.gz');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(SAMPLE_TILE_GZ.length),
    });
    res.end(SAMPLE_TILE_GZ);
    return;
  }
  log('origin', req, '-> 200 page');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});

origin.listen(8791, HOST, () => console.log(`origin      http://${HOST}:8791/probe.html`));
makeCdn('cdn-ok', CORS_OK, true).listen(8792, HOST, () => console.log('cdn-ok      :8792 (preflight allows Range, exposes Content-Range)'));
makeCdn('cdn-narrow', CORS_NARROW, false).listen(8793, HOST, () => console.log('cdn-narrow  :8793 (Access-Control-Allow-Origin only)'));
