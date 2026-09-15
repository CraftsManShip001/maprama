/**
 * Local development server (Node) with in-memory adapters.
 *
 *   npm run dev:local -- [--port 8787] [--world <region>=<world.json>] [--tiles <tileset>=<file.pmtiles>]
 *
 * Prints freshly generated client/admin keys on start (dev only; nothing is persisted).
 */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { validateWorldData, type WorldData } from '@diorama/protocol';
import { createApp } from '../app.js';
import { createMemoryDeps } from '../adapters/memory/index.js';
import { BLOB_KEYS, PLAN_DEFAULT_QUOTA } from '../config.js';
import { generateApiKey } from '../util/crypto.js';
import { seedFromWorld } from '../seed/world.js';

const argv = process.argv.slice(2);
const all = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []));
const port = Number(all('--port')[0] ?? 8787);

const deps = createMemoryDeps({
  receiptSecret: process.env.RECEIPT_SECRET ?? 'local-dev-receipt-secret-change-me-0000000000',
  // Dev only: lets webhooks target a receiver on this machine (http://localhost:<port>/...).
  options: { allowInsecureLocalWebhooks: true },
});

for (const spec of all('--world')) {
  const [region, path] = spec.split('=');
  if (!region || !path) throw new Error('--world expects <region>=<path>');
  const text = readFileSync(path, 'utf8');
  const world: unknown = JSON.parse(text);
  const valid = validateWorldData(world);
  if (!valid.ok) throw new Error(`Invalid world ${path}: ${valid.error}`);
  await deps.blobs.put(BLOB_KEYS.world(region), text, 'application/json');
  const seed = seedFromWorld(world as WorldData, region);
  await deps.places.upsert(seed.places);
  await deps.transit.upsertStations(seed.stations);
  console.log(`world ${region}: ${seed.places.length} places, ${seed.stations.length} stations`);
}
for (const spec of all('--tiles')) {
  const [tileset, path] = spec.split('=');
  if (!tileset || !path) throw new Error('--tiles expects <tileset>=<path>');
  await deps.blobs.put(BLOB_KEYS.tiles(tileset), readFileSync(path));
  console.log(`tileset ${tileset} loaded`);
}

for (const role of ['client', 'admin'] as const) {
  const { key, keyHash } = await generateApiKey(deps.crypto);
  await deps.keys.insert({ id: `dev-${role}`, keyHash, appId: 'dev-app', plan: 'free', monthlyQuota: PLAN_DEFAULT_QUOTA.free, role, createdAt: Date.now() });
  console.log(`${role} key (dev only): ${key}`);
}

serve({ fetch: createApp(deps).fetch, port }, (info) => console.log(`diorama-api listening on http://localhost:${info.port}`));
