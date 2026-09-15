import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverpassQuery, fetchOverpass, parseBBox } from '../src/overpass.js';

const bbox = { south: 37.541, west: 127.052, north: 37.548, east: 127.061 };

function response(status: number, body: string): Response {
  return new Response(body, { status, statusText: status === 200 ? 'OK' : 'ERR' });
}

describe('query', () => {
  it('parses bbox strings', () => {
    expect(parseBBox('37.5410,127.0520,37.5480,127.0610')).toEqual(bbox);
    expect(() => parseBBox('1,2,3')).toThrow(RangeError);
    expect(() => parseBBox('37.6,127,37.5,127.1')).toThrow(RangeError);
  });

  it('requests every layer with full geometry', () => {
    const q = buildOverpassQuery(bbox);
    expect(q).toMatch(/^\[out:json\]/);
    expect(q).toContain('(37.541,127.052,37.548,127.061);');
    for (const part of ['way["building"]', 'way["highway"]', 'relation["natural"="water"]', 'node["railway"="station"]', 'out geom;']) {
      expect(q).toContain(part);
    }
  });
});

describe('fetchOverpass', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const noSleep = async (): Promise<void> => {};

  it('falls back to the next endpoint, sends User-Agent + form body, and caches', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'diorama-osm-'));
    dirs.push(cacheDir);
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://a.example/api') return response(504, 'Gateway Timeout');
      return response(200, JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 37.544, lon: 127.056 }] }));
    }) as unknown as typeof fetch;

    const raw = await fetchOverpass(bbox, {
      endpoints: ['https://a.example/api', 'https://b.example/api'],
      fetchImpl,
      sleep: noSleep,
      cacheDir,
    });
    expect(raw.elements).toHaveLength(1);
    expect(raw.diorama?.endpoint).toBe('https://b.example/api');
    expect(raw.diorama?.bbox).toEqual(bbox);
    expect(calls).toHaveLength(2);
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/diorama-osm/);
    expect(calls[1]!.init.method).toBe('POST');
    expect(String(calls[1]!.init.body)).toMatch(/^data=/);

    const failing = (async () => {
      throw new Error('network should not be used');
    }) as unknown as typeof fetch;
    const cached = await fetchOverpass(bbox, { endpoints: ['https://a.example/api'], fetchImpl: failing, cacheDir });
    expect(cached.elements).toHaveLength(1);
  });

  it('retries runtime-error remarks and non-JSON bodies, then gives up', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return n % 2 === 1
        ? response(200, JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }))
        : response(200, '<html>busy</html>');
    }) as unknown as typeof fetch;
    await expect(
      fetchOverpass(bbox, { endpoints: ['https://a.example/api'], passes: 3, fetchImpl, sleep: noSleep, cacheDir: null }),
    ).rejects.toThrow(/all endpoints failed/);
    expect(n).toBe(3);
  });

  it('does not retry HTTP 400', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return response(400, 'parse error');
    }) as unknown as typeof fetch;
    await expect(
      fetchOverpass(bbox, { endpoints: ['https://a.example/api', 'https://b.example/api'], fetchImpl, sleep: noSleep, cacheDir: null }),
    ).rejects.toThrow(/rejected/);
    expect(n).toBe(1);
  });
});
