import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { tempDir, writeModel } from './helpers.js';

const tmp = tempDir();
afterAll(tmp.cleanup);

function capture(): { io: { stdout: (s: string) => void; stderr: (s: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, out, err };
}

describe('diorama CLI', () => {
  it('inspect prints a JSON report', async () => {
    const model = await writeModel(tmp.dir, 'cli.glb', { animations: ['Take 001'] });
    const c = capture();
    expect(await main(['inspect', model], c.io)).toBe(0);
    const report = JSON.parse(c.out[0]!) as { triangles: number; clips: { mappingNeeded: boolean } };
    expect(report.triangles).toBe(12);
    expect(c.err.some((l) => l.includes('"Take 001" does not match'))).toBe(true);
  });

  it('optimize writes the output and prints a summary', async () => {
    const model = await writeModel(tmp.dir, 'cli2.glb', { min: [0, 3, 0], max: [1, 4, 1] });
    const output = join(tmp.dir, 'cli2.opt.glb');
    const c = capture();
    const code = await main(['optimize', model, '-o', output, '--center-feet', '--max-triangles', '100', '--meshopt'], c.io);
    expect(code).toBe(0);
    expect(existsSync(output)).toBe(true);
    const summary = JSON.parse(c.out[0]!) as { triangles: { after: number }; bounds: { after: { min: number[] } } };
    expect(summary.triangles.after).toBe(12);
    expect(summary.bounds.after.min[1]).toBeCloseTo(0, 4);
  });

  it('rejects invalid usage with exit code 2', async () => {
    const model = await writeModel(tmp.dir, 'cli3.glb');
    expect(await main(['optimize', model, '-o', 'x.glb', '--draco', '--meshopt'], capture().io)).toBe(2);
    expect(await main(['optimize', model, '-o', 'x.glb', '--face', '+y'], capture().io)).toBe(2);
    expect(await main(['optimize', model], capture().io)).toBe(2);
    expect(await main(['optimize', model, '-o', 'x.glb', '--max-triangles', '-1'], capture().io)).toBe(2);
    expect(await main(['inspect'], capture().io)).toBe(2);
    expect(await main(['nope'], capture().io)).toBe(2);
    expect(await main(['help'], capture().io)).toBe(0);
  });

  it('returns 1 for unreadable files', async () => {
    expect(await main(['inspect', join(tmp.dir, 'missing.glb')], capture().io)).toBe(1);
  });
});
