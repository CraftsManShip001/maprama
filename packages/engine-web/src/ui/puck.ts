/**
 * Location puck (prototype `puck` / `stepPuck`): accuracy disc, heading cone,
 * white ring and blue dot on the ground under the player; the marker grows
 * with camera distance so it stays readable when zoomed out.
 *
 * @module
 */

import { CircleGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { clamp } from '../util/math.js';

export class LocationPuck {
  readonly group = new Group();
  private readonly acc: Mesh;
  private readonly marker = new Group();
  private readonly mats: MeshBasicMaterial[] = [];

  constructor() {
    this.group.name = 'location-puck';
    this.group.visible = false;
    const mat = (c: number, o: number): MeshBasicMaterial => {
      const m = new MeshBasicMaterial({ color: c, transparent: o < 1, opacity: o, depthWrite: false });
      this.mats.push(m);
      return m;
    };
    this.acc = new Mesh(new CircleGeometry(1, 40).rotateX(-Math.PI / 2), mat(0x3f7bff, 0.14));
    const cone = new Mesh(new CircleGeometry(1.7, 16, -Math.PI / 2 - 0.45, 0.9).rotateX(-Math.PI / 2), mat(0x3f7bff, 0.4));
    const ring = new Mesh(new CircleGeometry(0.5, 28).rotateX(-Math.PI / 2), mat(0xffffff, 1));
    const dot = new Mesh(new CircleGeometry(0.38, 28).rotateX(-Math.PI / 2), mat(0x2f6bff, 1));
    this.acc.position.y = 0.04;
    cone.position.y = 0.045;
    ring.position.y = 0.05;
    dot.position.y = 0.055;
    [this.acc, cone, ring, dot].forEach((m, i) => { m.renderOrder = 8 + i; m.raycast = () => {}; });
    this.marker.add(cone, ring, dot);
    this.group.add(this.acc, this.marker);
  }

  /**
   * @param accuracyUnits accuracy radius in world units, `null` hides the disc.
   */
  update(visible: boolean, x: number, y: number, z: number, yaw: number, cameraDistance: number, accuracyUnits: number | null): void {
    this.group.visible = visible;
    if (!visible) return;
    this.group.position.set(x, y, z);
    this.marker.rotation.y = yaw;
    this.marker.scale.setScalar(clamp(cameraDistance / 30, 1, 5));
    this.acc.visible = accuracyUnits !== null;
    if (accuracyUnits !== null) this.acc.scale.setScalar(Math.max(1.4, accuracyUnits * 2.2));
  }

  dispose(): void {
    this.group.traverse((o) => { const m = o as Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.mats) m.dispose();
  }
}
