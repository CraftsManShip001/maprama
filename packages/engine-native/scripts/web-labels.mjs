/**
 * Loads engine-web's pure label modules (`packages/engine-web/src/labels/index.ts` and `icons.ts`) without
 * changing engine-web: its dist bundle does not export them, so the two TypeScript sources are transpiled
 * (types stripped, nothing else) with the repository's `typescript` into `build/web-labels/*.mjs` and
 * imported from there. Both modules only have type imports besides `./icons.js`.
 *
 * Used by `export-fixtures.mjs` (the `labels.json` conformance fixture) and `generate-label-icons.mjs`
 * (the icon / subtitle / colour tables embedded in the C++ core).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const srcDir = new URL('../../engine-web/src/labels/', import.meta.url);
const outDir = new URL('../build/web-labels/', import.meta.url);

function transpile(name) {
  const source = readFileSync(new URL(`${name}.ts`, srcDir), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: `${name}.ts`,
  });
  // `.mjs` so Node treats the output as ESM regardless of the enclosing package.json.
  writeFileSync(new URL(`${name}.mjs`, outDir), outputText.replaceAll("'./icons.js'", "'./icons.mjs'"));
}

/** `{...index.ts exports, ...icons.ts exports}` of engine-web's label modules. */
export async function loadWebLabels() {
  mkdirSync(outDir, { recursive: true });
  transpile('icons');
  transpile('index');
  const icons = await import(new URL('icons.mjs', outDir).href);
  const index = await import(new URL('index.mjs', outDir).href);
  return { ...icons, ...index };
}
