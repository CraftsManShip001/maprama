import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { validateWorldData, type WorldData } from '@maprama/protocol';
import { main } from '../src/cli.js';

const dir = mkdtempSync(join(tmpdir(), 'maprama-osm-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function capture(): { io: { stdout: (s: string) => void; stderr: (s: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, out, err };
}

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('maprama-osm CLI', () => {
  it('build writes a valid world and prints stats', async () => {
    const out = join(dir, 'world.json');
    const c = capture();
    const code = await main(
      ['build', '--raw', fixture('basic.overpass.json'), '--out', out, '--name', 'CLI', '--kr-buildings', fixture('kr-buildings.geojson'), '--simplify-meters', '0.5'],
      c.io,
    );
    expect(code).toBe(0);
    const world = JSON.parse(readFileSync(out, 'utf8')) as WorldData;
    expect(validateWorldData(world).ok).toBe(true);
    expect(world.name).toBe('CLI');
    const stats = JSON.parse(c.out[0]!) as { valid: boolean; buildings: number };
    expect(stats.valid).toBe(true);
    expect(stats.buildings).toBe(world.buildings.length);
  });

  it('build warns on stderr when the plaza stands in open space, and still writes it', async () => {
    const raw = JSON.parse(readFileSync(fixture('basic.overpass.json'), 'utf8')) as {
      elements: { type: string; id: number; lat?: number; lon?: number }[];
    };
    const plazaNode = raw.elements.find((e) => e.type === 'node' && e.id === 108)!;
    plazaNode.lat = 37.543425; // empty ground south of every building
    plazaNode.lon = 127.056;
    const rawPath = join(dir, 'open-plaza.overpass.json');
    writeFileSync(rawPath, JSON.stringify(raw));

    const out = join(dir, 'world-open-plaza.json');
    const c = capture();
    expect(await main(['build', '--raw', rawPath, '--out', out, '--name', 'CLI plaza'], c.io)).toBe(0);
    expect(c.err.join('\n')).toContain('stands in open space');
    expect(c.err.join('\n')).toContain('will have nothing under it');
    // the plaza is legitimate data and is written either way
    expect((JSON.parse(readFileSync(out, 'utf8')) as WorldData).plaza).toBeDefined();

    // the unmoved fixture plaza sits a few metres from a footprint: silence
    const quiet = capture();
    const quietOut = join(dir, 'world-covered-plaza.json');
    expect(await main(['build', '--raw', fixture('basic.overpass.json'), '--out', quietOut, '--name', 'CLI plaza'], quiet.io)).toBe(0);
    expect(quiet.err).toEqual([]);
    expect((JSON.parse(readFileSync(quietOut, 'utf8')) as WorldData).plaza).toBeDefined();
  });

  it('build accepts --origin lat,lng and --unit-meters', async () => {
    const out = join(dir, 'world2.json');
    const code = await main(
      ['build', '--raw', fixture('basic.overpass.json'), '--out', out, '--name', 'CLI', '--origin', '37.544,127.055', '--unit-meters', '4'],
      capture().io,
    );
    expect(code).toBe(0);
    const world = JSON.parse(readFileSync(out, 'utf8')) as WorldData;
    expect(world.origin).toEqual({ lat: 37.544, lng: 127.055 });
    expect(world.unitMeters).toBe(4);
  });

  it('build --kr-fill-missing adds the buildings OSM is missing and reports the counts', async () => {
    const out = join(dir, 'world-filled.json');
    const c = capture();
    const code = await main(
      [
        'build',
        '--raw',
        fixture('fill-gaps.overpass.json'),
        '--out',
        out,
        '--name',
        'CLI fill',
        '--kr-buildings',
        fixture('fill-gaps.kr.geojson'),
        '--kr-fill-missing',
      ],
      c.io,
    );
    expect(code).toBe(0);
    const world = JSON.parse(readFileSync(out, 'utf8')) as WorldData;
    expect(validateWorldData(world).ok).toBe(true);
    expect(world.buildings).toHaveLength(3);
    const stats = JSON.parse(c.out[0]!) as Record<string, number>;
    expect(stats).toMatchObject({ buildings: 3, buildingsFromOsm: 1, buildingsFilled: 2, krFillSkipped: 1 });
  });

  it('build --kr-fill-missing without --kr-buildings is a usage error', async () => {
    const c = capture();
    const code = await main(
      ['build', '--raw', fixture('fill-gaps.overpass.json'), '--out', join(dir, 'x.json'), '--name', 'x', '--kr-fill-missing'],
      c.io,
    );
    expect(code).toBe(2);
    expect(c.err.join('\n')).toContain('--kr-fill-missing requires --kr-buildings');
  });

  it('help documents --kr-fill-missing', async () => {
    const c = capture();
    expect(await main(['help'], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('--kr-fill-missing');
  });

  it('usage errors exit with 2', async () => {
    expect(await main(['build', '--raw', 'x.json'], capture().io)).toBe(2);
    expect(await main(['sample', 'atlantis'], capture().io)).toBe(2);
    expect(await main(['frobnicate'], capture().io)).toBe(2);
    expect(await main(['build', '--bogus'], capture().io)).toBe(2);
    expect(await main(['help'], capture().io)).toBe(0);
  });
});
