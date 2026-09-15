// Copies read-only sample worlds into docs/public/worlds for the playground:
//   - tools/osm/samples/seongsu.world.json (ODbL 1.0; attribution file sits next to it)
//   - packages/engine-web/dev/sample-world.json
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(docs, '..');
const out = join(docs, 'public', 'worlds');
mkdirSync(out, { recursive: true });

const copies = [
  [join(repo, 'tools', 'osm', 'samples', 'seongsu.world.json'), join(out, 'seongsu.world.json')],
  [join(repo, 'packages', 'engine-web', 'dev', 'sample-world.json'), join(out, 'sample.world.json')],
];
for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`gen-assets: missing ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
}
if (!existsSync(join(out, 'seongsu.world.ATTRIBUTION.txt'))) {
  console.error('gen-assets: public/worlds/seongsu.world.ATTRIBUTION.txt is missing (ODbL attribution must ship next to the data)');
  process.exit(1);
}
console.log('gen-assets: copied sample worlds to public/worlds');
