import { encodeCommand, type EngineEvent, type WorldData } from '@maprama/protocol';
import { describe, expect, it } from 'vitest';
import { CameraController } from '../core/camera.js';
import { createRequestHandlers, projectionFor } from '../engine/requests.js';
import { loadWorldData } from '../world/data.js';
import { Dispatcher, EngineError, NOT_IMPLEMENTED, UNSUPPORTED } from './dispatcher.js';
import { createDirectTransport } from './transport.js';

const world: WorldData = {
  version: 1,
  name: 'Req',
  origin: { lng: 127.0, lat: 37.5 },
  unitMeters: 8,
  bounds: { minX: -50, minZ: -50, maxX: 50, maxZ: 50 },
  roads: [
    { id: 'main', cls: 'arterial', pts: [[-50, 0], [50, 0]] },
    { id: 'cross', cls: 'local', pts: [[0, -50], [0, 50]] },
  ],
  buildings: [{ id: 'tower', footprint: [[10, 10], [30, 10], [30, 30], [10, 30]], height: 6 }],
  water: [],
  parks: [],
  pois: [],
  stations: [{ id: 'a', name: 'A', x: -40, z: 2 }, { id: 'b', name: 'B', x: 40, z: -2 }],
  districts: [],
  attribution: [],
};

function setup() {
  const events: EngineEvent[] = [];
  const d = new Dispatcher((e) => events.push(e));
  return { d, events };
}

describe('Dispatcher', () => {
  it('routes valid commands to registered handlers', async () => {
    const { d, events } = setup();
    const seen: unknown[] = [];
    d.register('setUi', (cmd) => { seen.push(cmd.ui); });
    await d.receive(encodeCommand({ type: 'setUi', ui: { scaleBar: true } }, 0));
    expect(seen).toEqual([{ scaleBar: true }]);
    expect(events).toEqual([]);
  });

  it('emits invalid_message for invalid JSON and invalid commands', async () => {
    const { d, events } = setup();
    await d.receive('{not json');
    await d.receive(JSON.stringify({ v: 1, seq: 0, kind: 'cmd', msg: { type: 'setCamera' } }));
    await d.receive(JSON.stringify({ v: 1, seq: 1, kind: 'cmd', msg: { type: 'fly' } }));
    expect(events.map((e) => e.type === 'error' && e.code)).toEqual(['invalid_message', 'invalid_message', 'invalid_message']);
    expect(events.every((e) => e.type === 'error' && !e.fatal)).toBe(true);
  });

  it('answers an invalid request with a failed response too', async () => {
    const { d, events } = setup();
    await d.receive(JSON.stringify({ v: 1, seq: 0, kind: 'cmd', msg: { type: 'request', requestId: 'r1', method: 'project', params: {} } }));
    expect(events.map((e) => e.type)).toEqual(['error', 'response']);
    expect(events[1]).toMatchObject({ requestId: 'r1', ok: false, error: { code: 'invalid_message' } });
  });

  it('reports unregistered commands and requests as protocol `unsupported` (non-fatal)', async () => {
    const { d, events } = setup();
    await d.dispatch({ type: 'travel', requestId: 't', characterId: 'me', to: { lng: 0, lat: 0 }, modes: ['walk'] });
    await d.dispatch({ type: 'request', requestId: 'q', method: 'route', params: { from: { lng: 0, lat: 0 }, to: { lng: 0, lat: 0 }, modes: ['walk'] } });
    expect(UNSUPPORTED).toBe('unsupported');
    expect(events.some((e) => JSON.stringify(e).includes(NOT_IMPLEMENTED))).toBe(false);
    expect(events[0]).toEqual({ type: 'error', code: UNSUPPORTED, message: expect.stringContaining('travel'), fatal: false });
    expect(events[1]).toMatchObject({ type: 'response', requestId: 'q', ok: false, error: { code: UNSUPPORTED } });
    expect(d.unimplemented()).toContain('travel');
  });

  it('lets later registrations replace handlers and maps thrown errors to codes', async () => {
    const { d, events } = setup();
    d.register('setUi', () => { throw new Error('first'); });
    d.register('setUi', () => { throw new EngineError('custom_code', 'second'); });
    await d.dispatch({ type: 'setUi', ui: {} });
    expect(events[0]).toMatchObject({ type: 'error', code: 'custom_code', fatal: false });
  });

  it('processes commands in order even when handlers are async', async () => {
    const { d } = setup();
    const order: string[] = [];
    d.register('setUi', async () => { await new Promise((r) => setTimeout(r, 10)); order.push('ui'); });
    d.register('setTheme', () => { order.push('theme'); });
    void d.dispatch({ type: 'setUi', ui: {} });
    await d.dispatch({ type: 'setTheme', theme: {} });
    expect(order).toEqual(['ui', 'theme']);
  });

  // On-demand rendering: the engine asks for one frame after every command.
  it('calls onCommand exactly once per command, including when the handler throws', async () => {
    const seen: string[] = [];
    const d = new Dispatcher(() => {}, (cmd) => seen.push(cmd.type));
    d.register('setUi', () => {});
    d.register('setTheme', async () => { await new Promise((r) => setTimeout(r, 1)); });
    d.register('setLabels', () => { throw new EngineError('boom', 'nope'); });
    await d.dispatch({ type: 'setUi', ui: {} });
    expect(seen).toEqual(['setUi']);
    await d.dispatch({ type: 'setTheme', theme: {} });
    await d.dispatch({ type: 'setLabels', labels: {} });
    expect(seen).toEqual(['setUi', 'setTheme', 'setLabels']);
  });

  it('does not call onCommand for requests (they change nothing on screen)', async () => {
    const seen: string[] = [];
    const d = new Dispatcher(() => {}, (cmd) => seen.push(cmd.type));
    d.registerRequest('project', () => ({ x: 1, y: 2, visible: true }));
    await d.dispatch({ type: 'request', requestId: 'r', method: 'project', params: { coordinate: { lng: 127, lat: 37.5 } } });
    expect(seen).toEqual([]);
  });
});

describe('request handlers through the direct transport', () => {
  const model = loadWorldData(world);
  const cam = new CameraController();
  cam.setViewport(400, 800);
  cam.set({ x: 5, z: -3, distance: 40, pitch: 45, bearing: 30 });
  cam.apply();

  const transport = createDirectTransport();
  const d = new Dispatcher((e) => transport.send(JSON.stringify({ v: 1, seq: 0, kind: 'evt', msg: e })));
  const h = createRequestHandlers({
    world: () => model,
    view: cam,
    // 6 world units of building on a ground at 0 = 48 m at 8 m/unit.
    roofY: (id) => (id === 'tower' ? 6 : null),
    groundY: () => 0,
  });
  d.registerRequest('project', h.project);
  d.registerRequest('unproject', h.unproject);
  d.registerRequest('snapToRoad', h.snapToRoad);
  d.registerRequest('route', h.route);
  transport.onMessage((raw) => { void d.receive(raw); });
  const responses = new Map<string, EngineEvent>();
  transport.onEvent((e) => { if (e?.type === 'response') responses.set(e.requestId, e); });
  const proj = projectionFor(model);

  it('project → unproject round-trips a coordinate', async () => {
    const coordinate = proj.toLngLat({ x: 8, z: -1 });
    transport.postCommand({ type: 'request', requestId: 'p', method: 'project', params: { coordinate } });
    await d.dispatch({ type: 'setUi', ui: {} }).catch(() => {});
    const p = responses.get('p');
    expect(p).toMatchObject({ ok: true });
    const pt = (p as { result: { x: number; y: number; visible: boolean } }).result;
    expect(pt.visible).toBe(true);
    transport.postCommand({ type: 'request', requestId: 'u', method: 'unproject', params: { x: pt.x, y: pt.y } });
    await d.dispatch({ type: 'setUi', ui: {} }).catch(() => {});
    const u = responses.get('u') as { ok: true; result: { coordinate: { lng: number; lat: number } } };
    expect(u.ok).toBe(true);
    expect(u.result.coordinate.lng).toBeCloseTo(coordinate.lng, 7);
    expect(u.result.coordinate.lat).toBeCloseTo(coordinate.lat, 7);
  });

  it('the screen center projects to the camera target and north-up math is consistent', () => {
    const c = cam.worldToScreen(5, 0, -3);
    expect(c.x).toBeCloseTo(200, 3);
    expect(c.y).toBeCloseTo(400, 3);
    const north = new CameraController();
    north.setViewport(400, 800);
    north.set({ x: 0, z: 0, distance: 40, pitch: 0, bearing: 90 });
    north.apply();
    // bearing 90: east is up on screen
    expect(north.worldToScreen(10, 0, 0).y).toBeLessThan(400);
  });

  it('unproject returns null above the horizon', async () => {
    const r = await h.unproject({ x: 200, y: -5000 });
    expect(r.coordinate).toBeNull();
  });

  it('snapToRoad honours maxDistanceMeters', async () => {
    const near = await h.snapToRoad({ coordinate: proj.toLngLat({ x: 10, z: 2 }) });
    expect(near).toMatchObject({ roadId: 'main' });
    expect(near!.distanceMeters).toBeCloseTo(16, 3);
    expect(await h.snapToRoad({ coordinate: proj.toLngLat({ x: 10, z: 2 }), maxDistanceMeters: 5 })).toBeNull();
  });

  it('route returns legs, meters and ETA', async () => {
    const r = await h.route({ from: proj.toLngLat({ x: -20, z: 1 }), to: proj.toLngLat({ x: 1, z: 20 }), modes: ['walk'] });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.mode).toBe('walk');
    expect(r.meters).toBeGreaterThan((20 + 20) * 8 - 1);
    expect(r.etaSeconds).toBeCloseTo(r.meters / (4.8 / 3.6), 6);
    const sub = await h.route({ from: proj.toLngLat({ x: -38, z: 5 }), to: proj.toLngLat({ x: 38, z: -5 }), modes: ['subway'] });
    expect(sub.legs.map((l) => l.mode)).toEqual(['walk', 'subway', 'walk']);
  });
});

describe('snapToBuilding', () => {
  const model = loadWorldData(world);
  const proj = projectionFor(model);
  const services = { world: () => model, view: new CameraController(), roofY: (id: string) => (id === 'tower' ? 6 : null), groundY: () => 0 };
  const h = createRequestHandlers(services);

  it('reports a coordinate already inside the footprint, with the drawn roof height', async () => {
    const r = await h.snapToBuilding({ coordinate: proj.toLngLat({ x: 20, z: 20 }) });
    expect(r).toMatchObject({ buildingId: 'tower', inside: true, distanceMeters: 0 });
    expect(r!.heightMeters).toBeCloseTo(48);
    // `roofCoordinate` is the same ground point: a roof pin stands over it.
    expect(r!.roofCoordinate).toEqual(r!.coordinate);
  });

  it('snaps a coordinate outside the footprint and reports how far it moved', async () => {
    const r = await h.snapToBuilding({ coordinate: proj.toLngLat({ x: 8, z: 20 }) });
    expect(r).toMatchObject({ buildingId: 'tower', inside: false });
    expect(r!.distanceMeters).toBeCloseTo(16, 3); // 2 units at 8 m/unit
    // The answer is inside the building, not on its edge.
    const back = proj.toWorld(r!.coordinate);
    expect(back.x).toBeGreaterThan(10);
  });

  it('honours maxDistanceMeters and answers null beyond it', async () => {
    const far = proj.toLngLat({ x: -20, z: 20 });
    expect(await h.snapToBuilding({ coordinate: far })).toBeNull();
    expect(await h.snapToBuilding({ coordinate: proj.toLngLat({ x: 8, z: 20 }), maxDistanceMeters: 5 })).toBeNull();
  });

  it('answers null for a building the renderer does not draw', async () => {
    const blind = createRequestHandlers({ ...services, roofY: () => null });
    expect(await blind.snapToBuilding({ coordinate: proj.toLngLat({ x: 20, z: 20 }) })).toBeNull();
  });

  it('fails with not_ready before a world is loaded', async () => {
    const empty = createRequestHandlers({ world: () => null, view: new CameraController(), roofY: () => null });
    await expect(async () => empty.snapToBuilding({ coordinate: { lng: 127, lat: 37.5 } })).rejects.toThrow(EngineError);
  });
});
