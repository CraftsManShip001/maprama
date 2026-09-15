#!/usr/bin/env node
/**
 * Fails unless DESIGN.md's protocol mapping tables list every name in
 * ENGINE_COMMAND_TYPES and ENGINE_EVENT_TYPES exactly once (and nothing else),
 * and the command table mentions every REQUEST_METHODS entry.
 *
 * Tables are delimited by HTML comments:
 *   <!-- protocol-commands:start --> ... <!-- protocol-commands:end -->
 *   <!-- protocol-events:start -->   ... <!-- protocol-events:end -->
 * The first cell of each data row must contain the backticked name.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENGINE_COMMAND_TYPES, ENGINE_EVENT_TYPES, REQUEST_METHODS } from '@diorama/protocol';

// Optional argument: path to a DESIGN.md to check (defaults to this package's).
const designPath = process.argv[2] ?? fileURLToPath(new URL('../DESIGN.md', import.meta.url));
const md = readFileSync(designPath, 'utf8');
const failures = [];

function section(marker) {
  const start = md.indexOf(`<!-- ${marker}:start -->`);
  const end = md.indexOf(`<!-- ${marker}:end -->`);
  if (start < 0 || end < 0 || end < start) {
    failures.push(`DESIGN.md: markers for "${marker}" are missing or out of order`);
    return '';
  }
  return md.slice(start, end);
}

function firstColumnNames(text) {
  const names = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    if (/^\s*:?-{3,}/.test(firstCell)) continue; // separator row
    const match = firstCell.match(/`([^`]+)`/);
    if (match) names.push(match[1]);
  }
  return names;
}

function checkTable(marker, expected) {
  const text = section(marker);
  const names = firstColumnNames(text);
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  for (const name of expected) {
    if (!seen.has(name)) failures.push(`${marker}: missing row for \`${name}\``);
    else if (seen.get(name) > 1) failures.push(`${marker}: duplicate rows for \`${name}\``);
  }
  for (const name of seen.keys()) {
    if (!expected.includes(name)) failures.push(`${marker}: unknown name \`${name}\` (not in the protocol)`);
  }
  return { text, count: names.length };
}

const commands = checkTable('protocol-commands', ENGINE_COMMAND_TYPES);
const events = checkTable('protocol-events', ENGINE_EVENT_TYPES);
for (const method of REQUEST_METHODS) {
  if (!commands.text.includes(`\`${method}\``)) failures.push(`protocol-commands: request method \`${method}\` not mapped`);
}

if (failures.length > 0) {
  console.error(`check-design-coverage: ${failures.length} problem(s) in ${designPath}`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-design-coverage: DESIGN.md maps all ${ENGINE_COMMAND_TYPES.length} commands, ` +
    `${ENGINE_EVENT_TYPES.length} events and ${REQUEST_METHODS.length} request methods`,
);
