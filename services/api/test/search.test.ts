import { describe, expect, it } from 'vitest';
import type { Place } from '../src/deps.js';
import { bigrams, indexTokens, normalizeText, textScore } from '../src/search/normalize.js';
import { GANGNAM, SEONGSU, createHarness, json, north } from './helpers/harness.js';

type SearchJson = { query: string; results: { id: string; name: string; distanceMeters?: number; score: number; kind: string }[] };

const PLACES: Place[] = [
  { id: 'poi:sb-seongsu', kind: 'poi', name: '스타벅스 성수역점', category: 'cafe', coordinate: north(SEONGSU, 50), source: 'osm' },
  { id: 'poi:sb-gangnam', kind: 'poi', name: '스타벅스 강남역점', category: 'cafe', coordinate: north(GANGNAM, 50), source: 'osm' },
  { id: 'station:seongsu', kind: 'station', name: '성수역', category: 'subway', coordinate: SEONGSU, source: 'osm' },
  { id: 'poi:forest', kind: 'poi', name: '서울숲', category: 'park', coordinate: { lng: 127.0374, lat: 37.5444 }, source: 'osm' },
  { id: 'addr:1', kind: 'address', name: '왕십리로 83-21', address: '서울특별시 성동구 왕십리로 83-21', coordinate: SEONGSU, source: 'juso' },
];

async function seeded() {
  const h = createHarness();
  await h.deps.places.upsert(PLACES);
  return { h, key: await h.addKey() };
}

describe('normalization', () => {
  it('normalizes spacing, case and punctuation and builds bigrams', () => {
    expect(normalizeText(' 성수 역 (2호선) ')).toBe('성수역2호선');
    expect(normalizeText('ＳＥＯＵＬ Forest')).toBe('seoulforest');
    expect(bigrams('성수역')).toEqual(['성수', '수역']);
    expect(bigrams('숲')).toEqual(['숲']);
    expect(indexTokens('성수역', null)).toEqual(['성', '성수', '수역']);
    expect(textScore('성수역', '성수역')).toBe(1);
    expect(textScore('성수', '성수역')).toBe(0.9);
    expect(textScore('수역', '성수역')).toBe(0.8);
  });
});

describe('GET /v1/search', () => {
  it('ranks by text, blended with distance when near is given', async () => {
    const { h, key } = await seeded();
    const nearGangnam = await json<SearchJson>(await h.request(`/v1/search?q=스타벅스&near=${GANGNAM.lng},${GANGNAM.lat}`, { key }));
    expect(nearGangnam.results.map((r) => r.id)).toEqual(['poi:sb-gangnam', 'poi:sb-seongsu']);
    expect(nearGangnam.results[0]!.distanceMeters).toBeGreaterThan(40);
    expect(nearGangnam.results[0]!.distanceMeters).toBeLessThan(60);

    const nearSeongsu = await json<SearchJson>(await h.request(`/v1/search?q=스타벅스&near=${SEONGSU.lng},${SEONGSU.lat}`, { key }));
    expect(nearSeongsu.results.map((r) => r.id)).toEqual(['poi:sb-seongsu', 'poi:sb-gangnam']);
    expect(nearSeongsu.results[0]!.score).toBeGreaterThan(nearSeongsu.results[1]!.score);

    const noNear = await json<SearchJson>(await h.request('/v1/search?q=스타벅스', { key }));
    expect(noNear.results).toHaveLength(2);
    expect(noNear.results[0]!.distanceMeters).toBeUndefined();
  });

  it('prefers an exact name over partial matches and ignores spacing', async () => {
    const { h, key } = await seeded();
    const res = await json<SearchJson>(await h.request(`/v1/search?q=${encodeURIComponent('성수 역')}`, { key }));
    expect(res.results[0]).toMatchObject({ id: 'station:seongsu', kind: 'station', score: 1 });
    expect(res.results.map((r) => r.id)).toContain('poi:sb-seongsu');
  });

  it('matches addresses and one-character prefix queries, honours limit', async () => {
    const { h, key } = await seeded();
    const addr = await json<SearchJson>(await h.request(`/v1/search?q=${encodeURIComponent('왕십리로 83')}`, { key }));
    expect(addr.results[0]!.id).toBe('addr:1');
    // One-character queries are word-prefix matches (leading unigram / bigram prefix), not substrings.
    const one = await json<SearchJson>(await h.request('/v1/search?q=서', { key }));
    expect(one.results[0]!.id).toBe('poi:forest');
    expect(one.results.map((r) => r.id)).toContain('addr:1');
    const inner = await json<SearchJson>(await h.request('/v1/search?q=숲', { key }));
    expect(inner.results).toEqual([]);
    const limited = await json<SearchJson>(await h.request('/v1/search?q=스타벅스&limit=1', { key }));
    expect(limited.results).toHaveLength(1);
  });

  it('validates parameters', async () => {
    const { h, key } = await seeded();
    expect((await h.request('/v1/search?q=', { key })).status).toBe(400);
    expect((await h.request('/v1/search?q=%20!!', { key })).status).toBe(400);
    expect((await h.request('/v1/search?q=a&near=1', { key })).status).toBe(400);
    expect((await h.request('/v1/search?q=a&limit=500', { key })).status).toBe(400);
  });
});

describe('GET /v1/reverse', () => {
  it('returns the nearest address point within 200 m, or null', async () => {
    const { h, key } = await seeded();
    const at150 = north(SEONGSU, 150);
    const hit = await json<{ result: { id: string; distanceMeters: number } | null }>(await h.request(`/v1/reverse?lng=${at150.lng}&lat=${at150.lat}`, { key }));
    expect(hit.result?.id).toBe('addr:1');
    expect(hit.result!.distanceMeters).toBeGreaterThan(145);
    expect(hit.result!.distanceMeters).toBeLessThan(155);

    const at250 = north(SEONGSU, 250);
    const miss = await json<{ result: unknown }>(await h.request(`/v1/reverse?lng=${at250.lng}&lat=${at250.lat}`, { key }));
    expect(miss.result).toBeNull();

    const narrow = await json<{ result: unknown }>(await h.request(`/v1/reverse?lng=${at150.lng}&lat=${at150.lat}&radius=100`, { key }));
    expect(narrow.result).toBeNull();
    expect((await h.request(`/v1/reverse?lng=${at150.lng}&lat=${at150.lat}&radius=500`, { key })).status).toBe(400);
    expect((await h.request('/v1/reverse?lng=x&lat=1', { key })).status).toBe(400);
  });
});
