// Generates the TSDoc API reference (markdown) for @maprama/protocol and
// @maprama/react-native into docs/api/reference with typedoc + typedoc-plugin-markdown.
// Sources are read directly from packages/*/src (read-only); nothing outside docs/ is written.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(docs, 'node_modules', '.bin', process.platform === 'win32' ? 'typedoc.cmd' : 'typedoc');
const r = spawnSync(bin, ['--options', 'typedoc.json'], { cwd: docs, stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`gen-api: typedoc failed (exit ${r.status ?? r.signal})`);
  process.exit(1);
}
console.log('gen-api: wrote api/reference');
