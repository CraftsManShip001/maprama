// Prepares everything `docs:build` / `docs:dev` need, without touching other packages' dependencies:
//   1. docs/node_modules (installed from docs/package-lock.json with `npm ci`; docs is not a root workspace);
//   2. built @diorama/protocol and @diorama/engine-web (the playground imports their dist/), built only when missing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(docs, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, cwd) {
  console.log(`ensure-deps: npm ${args.join(' ')}`);
  const r = spawnSync(npm, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(join(docs, 'node_modules', 'vitepress', 'package.json'))) {
  run(['ci', '--no-audit', '--no-fund'], docs);
}
if (!existsSync(join(repo, 'packages', 'protocol', 'dist', 'index.js'))) {
  run(['run', 'build', '-w', '@diorama/protocol'], repo);
}
if (!existsSync(join(repo, 'packages', 'engine-web', 'dist', 'index.js'))) {
  run(['run', 'build', '-w', '@diorama/engine-web'], repo);
}
