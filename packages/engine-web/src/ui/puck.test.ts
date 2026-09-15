import { describe, expect, it } from 'vitest';
import { CameraController } from '../core/camera.js';
import { LocationPuck } from './puck.js';

const cameraAt = (distance: number): CameraController => {
  const cam = new CameraController();
  cam.setViewport(390, 760);
  cam.camera.updateProjectionMatrix();
  cam.set({ x: 0, z: 0, distance, pitch: 45, bearing: 0 });
  cam.apply();
  return cam;
};

describe('location puck HUD size', () => {
  const puck = new LocationPuck();
  /** Screen half size of the puck at ground `z` (0 = screen center, + = towards the camera) for a camera `distance`. */
  const halfAt = (distance: number, z = 0): number => {
    const cam = cameraAt(distance);
    puck.update(true, 0, 0, z, 0, distance, null);
    return puck.screenHalfSize(cam, 14);
  };

  it('uses the projected ring radius, never less than the lower bound', () => {
    // zoomed in (marker at scale 1): the ring is far larger than 14 px
    expect(halfAt(12)).toBeGreaterThan(30);
    // far zoom: the marker grows with the distance, so it stays ~17 px at the screen center...
    expect(halfAt(110)).toBeGreaterThan(16);
    expect(halfAt(110)).toBeCloseTo(halfAt(60), 3);
    // ...and gets larger nearer the bottom of the screen (closer to the camera)
    expect(halfAt(110, 25)).toBeGreaterThan(halfAt(110) + 3);
    // near the top of the screen (far from the camera) it projects smaller; 14 px is the lower bound
    expect(halfAt(110, -80)).toBe(14);
  });

  it('reports the ring radius at the camera-distance scale', () => {
    puck.update(true, 0, 0, 0, 0, 12, null);
    expect(puck.markerRadius()).toBeCloseTo(0.5, 9);
    puck.update(true, 0, 0, 0, 0, 150, null);
    expect(puck.markerRadius()).toBeCloseTo(2.5, 9);
  });
});
