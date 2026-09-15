// Builds @diorama/engine-web:
//   dist/index.js (+ .d.ts)   ESM library build (three and @diorama/protocol external)
//   dist/engine.iife.js       self-contained IIFE, global `DioramaEngine`
//   dist/engine.html          single-file HTML (IIFE inlined, full-viewport container, WebView transport)
//   dist/engine-html.js/.d.ts `export const ENGINE_HTML: string`
// The playground bundle is NOT built here (dist is published); `npm run dev` and
// scripts/screenshot.mjs build it into dev/build/ (gitignored).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

// declarations (typescript may be hoisted to the monorepo root)
const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const common = { bundle: true, platform: 'browser', target: ['es2020', 'safari15'], logLevel: 'warning', legalComments: 'none' };

await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(dist, 'index.js'),
  format: 'esm',
  sourcemap: true,
  external: ['three', 'three/*', '@diorama/protocol'],
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(dist, 'engine.iife.js'),
  format: 'iife',
  globalName: 'DioramaEngine',
  minify: true,
  // three's DRACOLoader builds default decoder URLs from import.meta.url at module
  // load; IIFE output has no import.meta, which threw and left DioramaEngine
  // undefined. The engine sets an explicit decoder path, so any absolute base works.
  define: { 'import.meta.url': JSON.stringify('https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/loaders/DRACOLoader.js') },
});

const iife = readFileSync(join(dist, 'engine.iife.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Diorama</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#d9dfe0;-webkit-tap-highlight-color:transparent;overscroll-behavior:none}#diorama-root{position:fixed;inset:0}</style>
</head>
<body>
<div id="diorama-root"></div>
<script>${iife}</script>
<script>(function(){var E=window.DioramaEngine;window.__diorama=E.createEngine(document.getElementById('diorama-root'),{transport:E.createWebViewTransport()});})();</script>
</body>
</html>
`;
writeFileSync(join(dist, 'engine.html'), html);
writeFileSync(join(dist, 'engine-html.js'), `/** Single-file engine HTML for WebView hosts (IIFE inlined, WebView transport). */\nexport const ENGINE_HTML = ${JSON.stringify(html)};\n`);
writeFileSync(join(dist, 'engine-html.d.ts'), `/** Single-file engine HTML for WebView hosts (IIFE inlined, WebView transport). */\nexport declare const ENGINE_HTML: string;\n`);

const kb = (f) => `${(statSync(join(dist, f)).size / 1024).toFixed(1)} KiB`;
for (const f of ['index.js', 'index.d.ts', 'engine.iife.js', 'engine.html', 'engine-html.js', 'engine-html.d.ts']) {
  console.log(`build: dist/${f} ${kb(f)}`);
}
