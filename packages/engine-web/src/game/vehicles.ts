/**
 * Travel vehicles (prototype `makeChar` vehicle section): bike, car, plane
 * and the translucent subway "ghost train", with pop-in / pop-out easing,
 * wheel spin, crank and propeller animation.
 *
 * @module
 */

import {
  BoxGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import type { TravelMode } from '@diorama/protocol';
import type { MaterialFactory } from '../theme/materials.js';
import { clamp } from '../util/math.js';

export type VehicleMode = Exclude<TravelMode, 'walk'>;
export const VEHICLE_MODES: readonly VehicleMode[] = ['bike', 'car', 'plane', 'subway'];

/** Adds a part: `(parent, geometry, material, x, y, z, outline, noSilhouette)` → the part's group. */
export type PartFn = (parent: Object3D, geo: BufferGeometry, mat: Material | Material[], x: number, y: number, z: number, outline: number, noSil?: boolean) => Group;

export interface Vehicle {
  group: Group;
  /** Pop-in progress 0..1. */
  p: number;
  /** +1 appearing, −1 disappearing, 0 idle. */
  dir: number;
  wheels: Group[];
  base: number;
  wheelR: number;
  crank?: Group;
  body?: Group;
  prop?: Group;
}

export type VehicleSet = Record<VehicleMode, Vehicle>;

/** Shared basic materials of vehicles (owned by the caller). */
export interface VehicleMaterials {
  skin: Material;
  tire: Material;
  chrome: Material;
  glassDark: Material;
}

/** Lathe capsule (prototype `capsule`). */
export function capsule(r: number, len: number, seg = 10): LatheGeometry {
  const pts: Vector2[] = [];
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2); pts.push(new Vector2(Math.max(0.0001, Math.cos(a) * r), Math.sin(a) * r - len / 2)); }
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * (Math.PI / 2); pts.push(new Vector2(Math.max(0.0001, Math.cos(a) * r), Math.sin(a) * r + len / 2)); }
  return new LatheGeometry(pts, seg);
}

/** Cylinder between two points (prototype `rod`). */
export function rod(a: [number, number, number], b: [number, number, number], r: number): CylinderGeometry {
  const A = new Vector3(...a), B = new Vector3(...b);
  const dir = B.clone().sub(A), len = dir.length();
  const geo = new CylinderGeometry(r, r, len, 8);
  geo.applyMatrix4(new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize())));
  geo.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return geo;
}

/** Back-out easing used for vehicle pop-in. */
export const easeOutBack = (x: number): number => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

const vehicle = (group: Group, extra: Partial<Vehicle> & { base: number; wheelR: number }): Vehicle => {
  group.visible = false;
  group.scale.setScalar(0.001);
  return { group, p: 0, dir: 0, wheels: [], ...extra };
};

/** Builds all vehicles under `root`. `owned` receives materials the caller must dispose. */
export function buildVehicles(root: Object3D, P: PartFn, mats: MaterialFactory, vm: VehicleMaterials, owned: Material[]): VehicleSet {
  // ---- bike ----
  const bike = new Group();
  root.add(bike);
  const frame = mats.make(0x1f7f6a, { roughness: 0.35, metalness: 0.35 });
  const bikeWheels: Group[] = [];
  for (const z of [0.52, -0.52]) {
    const w = new Group();
    w.position.set(0, 0.34, z);
    bike.add(w);
    P(w, new TorusGeometry(0.31, 0.04, 8, 32).rotateY(Math.PI / 2), vm.tire, 0, 0, 0, 0.012);
    P(w, new TorusGeometry(0.27, 0.012, 6, 28).rotateY(Math.PI / 2), vm.chrome, 0, 0, 0, 0, true);
    for (let s = 0; s < 6; s++) {
      const a = (s / 6) * Math.PI;
      P(w, rod([0, Math.cos(a) * 0.27, Math.sin(a) * 0.27], [0, -Math.cos(a) * 0.27, -Math.sin(a) * 0.27], 0.005), vm.chrome, 0, 0, 0, 0, true);
    }
    P(w, new CylinderGeometry(0.03, 0.03, 0.08, 8).rotateZ(Math.PI / 2), vm.chrome, 0, 0, 0, 0, true);
    bikeWheels.push(w);
  }
  const rear: [number, number, number] = [0, 0.34, -0.52], bb: [number, number, number] = [0, 0.3, -0.02], seatT: [number, number, number] = [0, 0.8, -0.17];
  const headT: [number, number, number] = [0, 0.86, 0.36], headB: [number, number, number] = [0, 0.68, 0.41], front: [number, number, number] = [0, 0.34, 0.52];
  const tubes: [[number, number, number], [number, number, number], number][] = [[bb, seatT, 0.022], [seatT, headT, 0.02], [bb, headB, 0.024], [bb, rear, 0.015], [seatT, rear, 0.014], [headB, front, 0.016], [headB, headT, 0.026], [headT, [0, 0.96, 0.33], 0.016]];
  for (const [a, b, r] of tubes) P(bike, rod(a, b, r), frame, 0, 0, 0, 0.012);
  P(bike, rod([-0.24, 0.96, 0.33], [0.24, 0.96, 0.33], 0.016), vm.chrome, 0, 0, 0, 0.012);
  P(bike, new BoxGeometry(0.12, 0.05, 0.24), vm.tire, 0, 0.845, -0.2, 0.012);
  const crank = new Group();
  crank.position.set(0, 0.3, -0.02);
  bike.add(crank);
  P(crank, rod([0.07, 0, 0], [0.07, -0.14, 0], 0.012), vm.chrome, 0, 0, 0, 0, true);
  P(crank, rod([-0.07, 0, 0], [-0.07, 0.14, 0], 0.012), vm.chrome, 0, 0, 0, 0, true);
  P(crank, new CylinderGeometry(0.07, 0.07, 0.02, 16).rotateZ(Math.PI / 2), vm.chrome, 0.04, 0, 0, 0, true);

  // ---- car ----
  const car = new Group();
  root.add(car);
  const body = new Group();
  car.add(body);
  const W = 1.12;
  const shapeOf = (pts: [number, number][]): Shape => {
    const s = new Shape();
    pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
    s.lineTo(pts[0]![0], pts[0]![1]);
    return s;
  };
  const ext = (shape: Shape, depth: number): ExtrudeGeometry => {
    const geo = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
    geo.rotateY(-Math.PI / 2);
    geo.translate(depth / 2, 0, 0);
    return geo;
  };
  const paint = mats.make(0xb0342c, { roughness: 0.3, metalness: 0.25 });
  P(body, ext(shapeOf([[-1.2, 0.3], [-1.22, 0.6], [-1.08, 0.68], [-0.78, 0.7], [-0.48, 0.98], [0.2, 1.0], [0.58, 0.72], [1.1, 0.63], [1.22, 0.5], [1.22, 0.3]]), W), paint, 0, 0, 0, 0.03);
  P(body, new BoxGeometry(W - 0.02, 0.1, 2.36), vm.tire, 0, 0.28, 0, 0, true);
  const side = shapeOf([[-0.7, 0.73], [-0.47, 0.95], [0.18, 0.965], [0.52, 0.735]]);
  for (const sx of [-1, 1]) {
    const sg = ext(side, 0.012);
    sg.translate(sx * (W / 2 + 0.006), 0, 0);
    P(body, sg, vm.glassDark, 0, 0, 0, 0, true);
    P(body, new BoxGeometry(0.02, 0.24, 0.05).translate(sx * (W / 2 + 0.012), 0.84, -0.12), paint, 0, 0, 0, 0, true);
    P(body, new BoxGeometry(0.1, 0.06, 0.1).translate(sx * (W / 2 + 0.06), 0.76, 0.5), paint, 0, 0, 0, 0.01, true);
  }
  P(body, new BoxGeometry(W * 0.88, 0.44, 0.012).rotateX(-0.935).translate(0, 0.868, 0.396), vm.glassDark, 0, 0, 0, 0, true);
  P(body, new BoxGeometry(W * 0.86, 0.36, 0.012).rotateX(0.82).translate(0, 0.847, -0.637), vm.glassDark, 0, 0, 0, 0, true);
  const headL = new MeshBasicMaterial({ color: 0xfff1d2 }), tailL = new MeshBasicMaterial({ color: 0xc8231c });
  owned.push(headL, tailL);
  for (const sx of [-1, 1]) {
    P(body, new BoxGeometry(0.24, 0.08, 0.02).translate(sx * 0.36, 0.55, 1.225), headL, 0, 0, 0, 0, true);
    P(body, new BoxGeometry(0.22, 0.07, 0.02).translate(sx * 0.4, 0.6, -1.225), tailL, 0, 0, 0, 0, true);
  }
  P(body, new SphereGeometry(0.12, 12, 10).scale(1, 1.1, 1), vm.skin, -0.24, 0.84, -0.05, 0, true);
  const carWheels: Group[] = [];
  for (const [x, z] of [[1, 0.78], [-1, 0.78], [1, -0.78], [-1, -0.78]] as const) {
    const w = new Group();
    w.position.set(x * (W / 2 + 0.01), 0.27, z);
    car.add(w);
    P(w, new CylinderGeometry(0.27, 0.27, 0.2, 18).rotateZ(Math.PI / 2), vm.tire, 0, 0, 0, 0.02);
    P(w, new CylinderGeometry(0.15, 0.15, 0.205, 12).rotateZ(Math.PI / 2), vm.chrome, 0, 0, 0, 0, true);
    carWheels.push(w);
  }

  // ---- plane ----
  const plane = new Group();
  root.add(plane);
  const pBody = mats.make(0xf7f9fc, { roughness: 0.35, metalness: 0.15 }), pAcc = mats.make(0x4da3ff, { roughness: 0.4 });
  P(plane, capsule(0.34, 2.0, 16).rotateX(Math.PI / 2).translate(0, 1.0, 0), pBody, 0, 0, 0, 0.02);
  P(plane, new BoxGeometry(3.3, 0.08, 0.72).translate(0, 0.95, 0.15), pBody, 0, 0, 0, 0.02);
  P(plane, new BoxGeometry(1.25, 0.06, 0.42).translate(0, 1.08, -1.2), pBody, 0, 0, 0, 0.02);
  P(plane, new BoxGeometry(0.06, 0.62, 0.5).translate(0, 1.38, -1.22), pAcc, 0, 0, 0, 0.02);
  P(plane, new BoxGeometry(3.32, 0.09, 0.16).translate(0, 0.95, 0.42), pAcc, 0, 0, 0, 0, true);
  P(plane, new SphereGeometry(0.24, 14, 10).scale(1, 0.72, 1.35).translate(0, 1.2, 0.72), vm.glassDark, 0, 0, 0, 0, true);
  P(plane, new SphereGeometry(0.11, 10, 8).translate(0, 1.0, 1.36), pAcc, 0, 0, 0, 0, true);
  const prop = new Group();
  prop.position.set(0, 1.0, 1.42);
  plane.add(prop);
  P(prop, new BoxGeometry(1.0, 0.09, 0.03), vm.tire, 0, 0, 0, 0, true);

  // ---- subway ghost train ----
  const sub = new Group();
  root.add(sub);
  const ghost = new MeshBasicMaterial({ color: 0x2e9e6b, transparent: true, opacity: 0.55, depthWrite: false, depthTest: false });
  const ghostHi = new MeshBasicMaterial({ color: 0xc8ffe4, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false });
  owned.push(ghost, ghostHi);
  for (let k = 0; k < 3; k++) {
    const carM = new Mesh(capsule(0.4, 1.3, 14).rotateX(Math.PI / 2).translate(0, 0.45, -k * 2.2), ghost);
    carM.renderOrder = 20;
    sub.add(carM);
    const win = new Mesh(new BoxGeometry(0.84, 0.14, 1.5).translate(0, 0.62, -k * 2.2), ghostHi);
    win.renderOrder = 21;
    sub.add(win);
  }

  return {
    bike: vehicle(bike, { wheels: bikeWheels, crank, base: 1, wheelR: 0.33 }),
    car: vehicle(car, { wheels: carWheels, body, base: 1.25, wheelR: 0.27 }),
    plane: vehicle(plane, { base: 0.9, wheelR: 1, prop }),
    subway: vehicle(sub, { base: 1, wheelR: 1 }),
  };
}

/** Starts showing `mode`'s vehicle and hides the others (prototype `setMode`). */
export function switchVehicle(set: VehicleSet, mode: TravelMode): void {
  for (const k of VEHICLE_MODES) {
    const v = set[k];
    if (k === mode) {
      v.group.visible = true;
      v.dir = 1;
    } else if (v.group.visible) v.dir = -1;
  }
}

/** Advances pop-in easing, wheels and propeller (prototype `updateChar` vehicle part). */
export function stepVehicles(set: VehicleSet, mode: TravelMode, speed: number, dt: number, t: number, planePitch: number, reduceMotion: boolean): void {
  for (const k of VEHICLE_MODES) {
    const v = set[k];
    if (v.dir) {
      v.p = reduceMotion ? (v.dir > 0 ? 1 : 0) : clamp(v.p + (v.dir * dt) / 0.35, 0, 1);
      if (v.p === 0 && v.dir < 0) { v.group.visible = false; v.dir = 0; }
      if (v.p === 1) v.dir = 0;
    }
    v.group.scale.setScalar(Math.max(0.001, easeOutBack(v.p) * v.base));
    if (mode === k) for (const w of v.wheels) w.rotation.x += (speed * dt) / v.wheelR;
  }
  if (set.plane.group.visible && set.plane.prop) set.plane.prop.rotation.z += dt * 35;
  set.plane.group.rotation.x = planePitch;
  if (mode === 'car' && set.car.body) set.car.body.position.y = Math.sin(t * 18) * 0.012 * Math.min(1, speed / 4);
}
