import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL_ICONS, validateEngineEvent, type WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { projectionFor } from '../engine/requests.js';
import { loadWorldData } from '../world/data.js';
import { buildTownWorld } from '../world/town.js';
import { resolveLabels } from './controller.js';
import { HOLO_ICONS, ICON_COLORS } from './icons.js';
import {
  buildLabelEntries,
  domLabelVisible,
  holoEligible,
  hudExclusions,
  iconTileFor,
  placeHolo,
  resolveLabelContent,
  toLabelInfo,
  uprightAngle,
  type HoloCandidate,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, '../../dev/sample-world.json'), 'utf8')) as WorldData;
const seongsuPath = join(here, '../../../../tools/osm/samples/seongsu.world.json');

describe('label index', () => {
  it('builds stable, unique ids and a valid labelsIndex for sample WorldData', () => {
    const w = loadWorldData(sample);
    const a = buildLabelEntries(w, projectionFor(w));
    const b = buildLabelEntries(loadWorldData(sample), projectionFor(loadWorldData(sample)));
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    const ids = a.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['district:Jung-gu', 'district:Pond', 'poi:poi-cafe', 'poi:poi-subway', 'poi:poi-park', 'road:road-sejong:0', 'road:road-cross:0']));
    // unnamed alley and the bridge get no labels
    expect(ids.some((id) => id.startsWith('road:road-alley') || id.startsWith('road:road-footbridge'))).toBe(false);
    const infos = a.map(toLabelInfo);
    expect(validateEngineEvent({ type: 'labelsIndex', labels: infos })).toEqual({ ok: true });
    const cafe = infos.find((i) => i.id === 'poi:poi-cafe')!;
    expect(cafe).toMatchObject({ kind: 'poi', name: 'Corner Coffee', category: 'cafe', subtitle: '카페 · CAFE' });
    const pond = a.find((e) => e.id === 'district:Pond')!;
    expect(pond).toMatchObject({ water: true, icon: 'water' });
    const art = a.find((e) => e.id === 'road:road-sejong:0')!;
    expect(art).toMatchObject({ pri: 1, icon: 'avenue', roadClass: 'arterial' });
  });

  it('suffixes repeated district names and stays stable for procedural worlds', () => {
    const w = loadWorldData({ ...sample, districts: [{ name: 'Dong', x: 0, z: 0 }, { name: 'Dong', x: 5, z: 5 }] });
    expect(buildLabelEntries(w, projectionFor(w)).filter((e) => e.kind === 'district').map((e) => e.id)).toEqual(['district:Dong', 'district:Dong#2']);
    const t1 = buildTownWorld(0), t2 = buildTownWorld(0);
    expect(buildLabelEntries(t1, projectionFor(t1)).map((e) => e.id)).toEqual(buildLabelEntries(t2, projectionFor(t2)).map((e) => e.id));
  });

  it.skipIf(!existsSync(seongsuPath))('indexes the real Seongsu sample (55 POIs, no districts)', () => {
    const w = loadWorldData(JSON.parse(readFileSync(seongsuPath, 'utf8')) as WorldData);
    const e = buildLabelEntries(w, projectionFor(w));
    expect(e.filter((x) => x.kind === 'poi')).toHaveLength(55);
    expect(e.filter((x) => x.kind === 'district')).toHaveLength(0);
    expect(new Set(e.map((x) => x.id)).size).toBe(e.length);
    expect(validateEngineEvent({ type: 'labelsIndex', labels: e.map(toLabelInfo) })).toEqual({ ok: true });
  });
});

describe('label content', () => {
  const w = loadWorldData(sample);
  const cafe = buildLabelEntries(w, projectionFor(w)).find((e) => e.id === 'poi:poi-cafe')!;

  it('applies the content modes', () => {
    expect(resolveLabelContent(cafe, 'nameAndType')).toEqual({ title: 'Corner Coffee', subtitle: '카페 · CAFE', icon: 'cafe', showIcon: true, showSubtitle: true, custom: false });
    expect(resolveLabelContent(cafe, 'nameOnly')).toMatchObject({ showIcon: true, showSubtitle: false });
    expect(resolveLabelContent(cafe, 'textOnly')).toMatchObject({ showIcon: false, showSubtitle: false });
  });

  it('applies host custom content by label id, falling back to defaults', () => {
    const entries = { 'poi:poi-cafe': { title: '오늘의 카페', subtitle: '영업 중 · 22시까지', icon: 'music' as const } };
    expect(resolveLabelContent(cafe, 'custom', entries)).toEqual({ title: '오늘의 카페', subtitle: '영업 중 · 22시까지', icon: 'music', showIcon: true, showSubtitle: true, custom: true });
    expect(resolveLabelContent(cafe, 'custom', { 'poi:poi-cafe': { title: 'Only title' } })).toMatchObject({ title: 'Only title', icon: 'cafe', showSubtitle: false, custom: true });
    expect(resolveLabelContent(cafe, 'custom', {})).toMatchObject({ title: 'Corner Coffee', custom: false });
    // entries are ignored outside custom mode
    expect(resolveLabelContent(cafe, 'nameAndType', entries).title).toBe('Corner Coffee');
  });

  it('has an icon and color for every protocol label icon; resolves defaults and icon tiles', () => {
    for (const icon of LABEL_ICONS) {
      expect(HOLO_ICONS[icon]).toMatch(/^<svg/);
      expect(ICON_COLORS[icon]).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(resolveLabels({})).toEqual({ enabled: true, style: 'holo', icons: 'auto', content: 'nameAndType' });
    expect(iconTileFor('auto', false)).toBe('white');
    expect(iconTileFor('auto', true)).toBe('black');
    expect(iconTileFor('color', true)).toBe('color');
  });
});

describe('placement', () => {
  const cand = (id: string, over: Partial<HoloCandidate> = {}): HoloCandidate => ({ id, kind: 'poi', pri: 2, dT: 1, eligible: true, top: { x: 200, y: 400 }, onScreen: true, w: 100, h: 30, ...over });

  it('rejects cards over HUD exclusion zones', () => {
    const ex = hudExclusions(390, 760, { zoomButtons: true, scaleBar: true, attribution: true });
    const shown = placeHolo([cand('top', { top: { x: 200, y: 30 } }), cand('zoom', { top: { x: 360, y: 120 } }), cand('bottom', { top: { x: 200, y: 758 } }), cand('mid')], ex);
    expect([...shown.keys()]).toEqual(['mid']);
    // without zoom buttons the right column is free
    const noZoom = placeHolo([cand('zoom', { top: { x: 330, y: 130 } })], hudExclusions(390, 760, {}));
    expect([...noZoom.keys()]).toEqual(['zoom']);
  });

  it('places by priority then distance, skips overlaps, ineligible/off-screen cards and caps roads at 5', () => {
    const shown = placeHolo([
      cand('poi-far', { dT: 9 }),
      cand('district', { kind: 'district', pri: 0, dT: 50 }),
      cand('hidden', { top: { x: 200, y: 200 }, eligible: false }),
      cand('off', { top: { x: 200, y: 600 }, onScreen: false }),
    ], []);
    expect([...shown.keys()]).toEqual(['district']);
    const roads = Array.from({ length: 7 }, (_, i) => cand(`r${i}`, { kind: 'road', pri: 3, dT: i, top: { x: 50 + i * 0, y: 100 + i * 60 } }));
    expect([...placeHolo(roads, []).keys()]).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    const box = placeHolo([cand('a')], []).get('a')!;
    expect(box).toEqual({ x: 200, y: 400 - 15 - 2, hw: 55, hh: 19 });
  });

  it('visibility rules match the prototype', () => {
    expect(holoEligible('district', 0, 40)).toBe(false);
    expect(holoEligible('district', 0, 41)).toBe(true);
    expect(holoEligible('poi', 23, 0)).toBe(true);
    expect(holoEligible('road', 30, 121)).toBe(false);
    expect(domLabelVisible('app', { kind: 'road', pri: 3 }, 30, 0)).toBe(true);
    expect(domLabelVisible('minimal', { kind: 'road', pri: 3 }, 30, 0)).toBe(false);
    expect(domLabelVisible('clean', { kind: 'poi', pri: 2 }, 100, 0)).toBe(false);
    expect(uprightAngle(Math.PI * 0.75)).toBeCloseTo(-Math.PI * 0.25, 9);
  });
});
