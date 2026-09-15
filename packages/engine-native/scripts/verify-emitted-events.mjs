#!/usr/bin/env node
/**
 * Validates every event envelope the C++ core emitted during the conformance
 * tests (one JSON envelope per line) with the TypeScript `decodeEvent`, so
 * native output is accepted by the real host-side codec — not only by the C++
 * port of it.
 *
 * Usage: node scripts/verify-emitted-events.mjs build/emitted-events.jsonl
 */

import { readFileSync } from 'node:fs';
import { decodeEvent, ENGINE_EVENT_TYPES } from '@diorama/protocol';

const file = process.argv[2];
if (!file) {
  console.error('usage: verify-emitted-events.mjs <events.jsonl>');
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
const failures = [];
const types = new Map();
for (const [i, line] of lines.entries()) {
  const r = decodeEvent(line);
  if (!r.ok) {
    failures.push(`line ${i + 1}: ${r.error}\n    ${line.slice(0, 200)}`);
    continue;
  }
  types.set(r.value.msg.type, (types.get(r.value.msg.type) ?? 0) + 1);
}

// The skeleton must at least exercise these event kinds.
for (const required of ['ready', 'error', 'response']) {
  if (!types.has(required)) failures.push(`no "${required}" event was emitted`);
}
for (const type of types.keys()) {
  if (!ENGINE_EVENT_TYPES.includes(type)) failures.push(`unknown event type emitted: ${type}`);
}

if (lines.length === 0) failures.push('no events were emitted');

if (failures.length > 0) {
  console.error(`verify-emitted-events: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
const summary = [...types.entries()].map(([t, n]) => `${t}=${n}`).join(', ');
console.log(`verify-emitted-events: ${lines.length} C++-emitted envelopes accepted by decodeEvent (${summary})`);
