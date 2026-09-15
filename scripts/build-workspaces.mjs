#!/usr/bin/env node
// Builds every npm workspace that has a `build` script, dependencies first.
//
// The order is a topological sort over the workspaces' `@maprama/*` dependencies (dependencies,
// peerDependencies and devDependencies), so a package is only built after the packages whose build
// output (JS and type declarations) it imports. `npm run build --workspaces` would use alphabetical
// order instead, which breaks on a clean checkout (e.g. engine-native before react-native).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const dirs = readJson(join(root, 'package.json')).workspaces.flatMap((pattern) => {
  if (!pattern.endsWith('/*')) return [pattern];
  const parent = pattern.slice(0, -2);
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
});

const workspaces = new Map();
for (const dir of dirs) {
  const file = join(root, dir, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = readJson(file);
  workspaces.set(pkg.name, pkg);
}

const localDeps = (pkg) =>
  Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies }).filter((name) => workspaces.has(name));

const order = [];
const state = new Map();
function visit(name, path) {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') throw new Error(`build-workspaces: dependency cycle ${[...path, name].join(' -> ')}`);
  state.set(name, 'visiting');
  for (const dep of localDeps(workspaces.get(name))) visit(dep, [...path, name]);
  state.set(name, 'done');
  order.push(name);
}
for (const name of [...workspaces.keys()].sort()) visit(name, []);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const name of order) {
  if (!workspaces.get(name).scripts?.build) continue;
  console.log(`build-workspaces: ${name}`);
  const result = spawnSync(npm, ['run', 'build', '-w', name], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
