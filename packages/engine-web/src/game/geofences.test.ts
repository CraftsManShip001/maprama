import { validateEngineEvent } from '@diorama/protocol';
import { describe, expect, it } from 'vitest';
import { GeofenceTracker } from './geofences.js';

describe('GeofenceTracker', () => {
  it('emits enter and exit on transitions only', () => {
    const g = new GeofenceTracker();
    g.set([{ id: 'plaza', x: 0, z: 0, r: 5 }]);
    expect(g.update([{ id: 'me', x: 10, z: 0 }])).toEqual([]);
    const enter = g.update([{ id: 'me', x: 4.9, z: 0 }]);
    expect(enter).toEqual([{ type: 'geofence:enter', geofenceId: 'plaza', characterId: 'me' }]);
    expect(validateEngineEvent(enter[0])).toEqual({ ok: true });
    expect(g.update([{ id: 'me', x: 1, z: 1 }])).toEqual([]);
    expect(g.isInside('plaza', 'me')).toBe(true);
    // exactly on the radius is outside
    expect(g.update([{ id: 'me', x: 5, z: 0 }])).toEqual([{ type: 'geofence:exit', geofenceId: 'plaza', characterId: 'me' }]);
    expect(g.update([{ id: 'me', x: 6, z: 0 }])).toEqual([]);
  });

  it('tracks several characters and fences independently', () => {
    const g = new GeofenceTracker();
    g.set([{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 10, z: 0, r: 3 }]);
    const ev = g.update([{ id: 'me', x: 0, z: 0 }, { id: 'npc', x: 10, z: 1 }]);
    expect(ev.map((e) => `${e.type}:${e.geofenceId}:${e.characterId}`)).toEqual(['geofence:enter:a:me', 'geofence:enter:b:npc']);
    const ev2 = g.update([{ id: 'me', x: 10, z: 0 }, { id: 'npc', x: 10, z: 1 }]);
    expect(ev2.map((e) => `${e.type}:${e.geofenceId}:${e.characterId}`)).toEqual(['geofence:exit:a:me', 'geofence:enter:b:me']);
  });

  it('keeps state for geofences that survive a replacement; forgets removed fences and characters', () => {
    const g = new GeofenceTracker();
    g.set([{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 0, z: 0, r: 10 }]);
    g.update([{ id: 'me', x: 0, z: 0 }]);
    g.set([{ id: 'a', x: 0, z: 0, r: 3 }]);
    expect(g.update([{ id: 'me', x: 0, z: 0 }])).toEqual([]);
    g.set([{ id: 'a', x: 0, z: 0, r: 3 }, { id: 'b', x: 0, z: 0, r: 10 }]);
    expect(g.update([{ id: 'me', x: 0, z: 0 }])).toEqual([{ type: 'geofence:enter', geofenceId: 'b', characterId: 'me' }]);
    // character removed → no exit; re-added → enter again
    expect(g.update([])).toEqual([]);
    expect(g.update([{ id: 'me', x: 0, z: 0 }]).map((e) => e.type)).toEqual(['geofence:enter', 'geofence:enter']);
  });
});
