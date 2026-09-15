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
import { decodeEvent, ENGINE_EVENT_TYPES } from '@maprama/protocol';

const file = process.argv[2];
if (!file) {
  console.error('usage: verify-emitted-events.mjs <events.jsonl>');
  process.exit(2);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
const failures = [];
const types = new Map();
/** Finer-grained kinds: `response` split by outcome / result shape, `error` by code. */
const kinds = new Map();
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
for (const [i, line] of lines.entries()) {
  const r = decodeEvent(line);
  if (!r.ok) {
    failures.push(`line ${i + 1}: ${r.error}\n    ${line.slice(0, 200)}`);
    continue;
  }
  const msg = r.value.msg;
  count(types, msg.type);
  if (msg.type === 'response') {
    if (!msg.ok) count(kinds, `response:error:${msg.error.code}`);
    else if (msg.result && typeof msg.result === 'object' && 'visible' in msg.result) count(kinds, 'response:project');
    else if (msg.result && typeof msg.result === 'object' && 'coordinate' in msg.result) count(kinds, 'response:unproject');
    else count(kinds, 'response:ok');
  } else if (msg.type === 'error') {
    count(kinds, `error:${msg.code}`);
  } else if (msg.type === 'camera:change') {
    const c = msg.camera;
    if (!(c.pitch >= 0 && c.pitch <= 60)) failures.push(`line ${i + 1}: camera:change pitch outside 0-60: ${c.pitch}`);
    if (!(c.bearing >= 0 && c.bearing < 360)) failures.push(`line ${i + 1}: camera:change bearing outside [0, 360): ${c.bearing}`);
    if (!(c.distance > 0)) failures.push(`line ${i + 1}: camera:change distance not positive: ${c.distance}`);
  }
}

// The core (M0 skeleton + M1 map session + M2a look / presses / overlays) must at least exercise these event kinds.
for (const required of ['ready', 'error', 'response', 'camera:change', 'map:press', 'building:press', 'overlay:positions']) {
  if (!types.has(required)) failures.push(`no "${required}" event was emitted`);
}
for (const required of [
  'response:project',
  'response:unproject',
  'response:error:unsupported',
  'response:error:not_ready',
  'error:invalid_message',
  'error:world_load_failed',
  // 'error:unsupported' is gone since M2b: procedural worlds were its last source (decodeCommand rejects
  // every other world kind).
  'error:unknown_building',
  'error:not_ready',
]) {
  if (!kinds.has(required)) failures.push(`no "${required}" event was emitted`);
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
const summary = [...types.entries(), ...kinds.entries()].map(([t, n]) => `${t}=${n}`).join(', ');
console.log(`verify-emitted-events: ${lines.length} C++-emitted envelopes accepted by decodeEvent (${summary})`);
