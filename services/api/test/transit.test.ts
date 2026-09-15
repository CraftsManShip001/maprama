import { describe, expect, it } from 'vitest';
import { GANGNAM, SEONGSU, createHarness, json } from './helpers/harness.js';

type StationJson = { id: string; name: string; coordinate: { lng: number; lat: number }; lineIds: string[] };

async function seeded() {
  const h = createHarness();
  await h.deps.transit.upsertStations([
    { id: 'seongsu', name: '성수역', coordinate: SEONGSU },
    { id: 'ttukseom', name: '뚝섬역', coordinate: { lng: 127.0471, lat: 37.5471 } },
    { id: 'gangnam', name: '강남역', coordinate: GANGNAM },
    { id: 'orphan', name: '임시역', coordinate: { lng: 127.05, lat: 37.55 } },
  ]);
  await h.deps.transit.upsertLine({ id: 'line2', name: '2호선', color: '#00A84D', stationIds: ['gangnam', 'seongsu', 'ttukseom'] });
  await h.deps.transit.upsertLine({ id: 'suin', name: '수인분당선', color: '#F5A200', stationIds: ['seongsu'] });
  return { h, key: await h.addKey() };
}

describe('GET /v1/transit/stations', () => {
  it('filters by bbox and includes line ids', async () => {
    const { h, key } = await seeded();
    const res = await h.request('/v1/transit/stations?bbox=127.04,37.54,127.06,37.56', { key });
    expect(res.status).toBe(200);
    const { stations } = await json<{ stations: StationJson[] }>(res);
    expect(stations.map((s) => s.id)).toEqual(['orphan', 'seongsu', 'ttukseom']);
    expect(stations.find((s) => s.id === 'seongsu')!.lineIds).toEqual(['line2', 'suin']);
    expect(stations.find((s) => s.id === 'orphan')!.lineIds).toEqual([]);
  });

  it('validates the bbox', async () => {
    const { h, key } = await seeded();
    expect((await h.request('/v1/transit/stations', { key })).status).toBe(400);
    expect((await h.request('/v1/transit/stations?bbox=127.06,37.54,127.04,37.56', { key })).status).toBe(400);
    expect((await h.request('/v1/transit/stations?bbox=120,30,130,40', { key })).status).toBe(400);
  });
});

describe('GET /v1/transit/lines/:lineId', () => {
  it('returns ordered stations and color, 404 for unknown lines', async () => {
    const { h, key } = await seeded();
    const line = await json<{ id: string; name: string; color: string; stations: StationJson[] }>(await h.request('/v1/transit/lines/line2', { key }));
    expect(line).toMatchObject({ id: 'line2', name: '2호선', color: '#00A84D' });
    expect(line.stations.map((s) => s.id)).toEqual(['gangnam', 'seongsu', 'ttukseom']);
    expect((await h.request('/v1/transit/lines/line9', { key })).status).toBe(404);
  });
});
