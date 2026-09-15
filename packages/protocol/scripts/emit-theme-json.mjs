// Writes dist/themes/<preset>.json from the compiled preset data so apps can
// `import urban from '@diorama/protocol/themes/urban.json'`.
// Run after `tsc -p tsconfig.build.json`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(pkgRoot, 'dist');
const outDir = join(distDir, 'themes');

const { PRESETS } = await import(pathToFileURL(join(distDir, 'presets', 'index.js')).href);

mkdirSync(outDir, { recursive: true });
for (const name of Object.keys(PRESETS)) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`emit-theme-json: missing preset "${name}"`);
  const file = join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(preset, null, 2) + '\n');
  console.log(`emit-theme-json: wrote ${file.slice(pkgRoot.length + 1)}`);
}
