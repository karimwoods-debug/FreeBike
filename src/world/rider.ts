import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Low-poly cyclist + bike (~600 triangles) with pedalling legs driven by
 * two-bone IK, rotating wheels, and a bit of body sway.
 * Local +Z is forward, +Y is up.
 */
const UP = new THREE.Vector3(0, 1, 0);

interface Limb {
  mesh: THREE.Mesh;
}

const shared = {
  limb: new THREE.CylinderGeometry(1, 1, 1, 5, 1).translate(0, 0.5, 0),
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.IcosahedronGeometry(1, 0),
  wheel: new THREE.TorusGeometry(0.33, 0.028, 3, 14).rotateY(Math.PI / 2),
  spokes: new THREE.BoxGeometry(0.01, 0.64, 0.02),
};

const vertexMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const mats = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: string): THREE.MeshLambertMaterial {
  let m = mats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    mats.set(color, m);
  }
  return m;
}

function placeLimb(l: Limb, a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  l.mesh.position.copy(a);
  l.mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len || 1));
  l.mesh.scale.set(r, len, r);
}

export interface RiderLook {
  jersey: string;
  shorts?: string;
  helmet?: string;
  bike?: string;
  skin?: string;
}

export class RiderModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private legs: { thigh: Limb; shin: Limb; foot: THREE.Mesh; side: number }[] = [];
  private crank: THREE.Group;
  private crankAngle = 0;
  private wheelAngle = 0;

  constructor(look: RiderLook) {
    const bikeCol = look.bike ?? '#202428';
    const skin = look.skin ?? '#e0b08a';
    this.root.add(this.body);

    // --- Bike ---------------------------------------------------------
    const W = 0.34;
    const rearAxle = new THREE.Vector3(0, W, -0.5);
    const frontAxle = new THREE.Vector3(0, W, 0.52);
    const bb = new THREE.Vector3(0, 0.3, 0);
    const seatTop = new THREE.Vector3(0, 0.88, -0.17);
    const headTop = new THREE.Vector3(0, 0.92, 0.42);
    const headBot = new THREE.Vector3(0, 0.72, 0.46);
    const tube = (a: THREE.Vector3, b: THREE.Vector3, r = 0.022, col = bikeCol) => {
      const l: Limb = { mesh: new THREE.Mesh(shared.limb, mat(col)) };
      placeLimb(l, a, b, r);
      this.body.add(l.mesh);
    };
    tube(bb, seatTop);
    tube(bb, headBot, 0.026);
    tube(seatTop, headTop);
    tube(headBot, headTop, 0.025);
    tube(bb, rearAxle, 0.015);
    tube(seatTop.clone().add(new THREE.Vector3(0, -0.06, 0)), rearAxle, 0.014);
    tube(headBot, frontAxle, 0.018);
    // bars + saddle
    const bar = new THREE.Mesh(shared.box, mat('#111'));
    bar.scale.set(0.42, 0.03, 0.03);
    bar.position.set(0, 0.95, 0.5);
    this.body.add(bar);
    tube(headTop, new THREE.Vector3(0, 0.95, 0.5), 0.016, '#111');
    const saddle = new THREE.Mesh(shared.box, mat('#111'));
    saddle.scale.set(0.12, 0.04, 0.26);
    saddle.position.set(0, 0.92, -0.18);
    this.body.add(saddle);

    for (const axle of [rearAxle, frontAxle]) {
      const w = new THREE.Group();
      w.position.copy(axle);
      w.add(new THREE.Mesh(shared.wheel, mat('#151515')));
      const s1 = new THREE.Mesh(shared.spokes, mat('#9aa0a6'));
      const s2 = s1.clone();
      s2.rotation.x = Math.PI / 2;
      w.add(s1, s2);
      this.body.add(w);
      this.wheels.push(w);
    }

    this.crank = new THREE.Group();
    this.crank.position.copy(bb);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 10).rotateZ(Math.PI / 2), mat('#777'));
    ring.position.x = 0.06;
    this.crank.add(ring);
    this.body.add(this.crank);

    // --- Rider --------------------------------------------------------
    const hip = new THREE.Vector3(0, 1.0, -0.15);
    const shoulder = new THREE.Vector3(0, 1.38, 0.3);
    const torso = new THREE.Mesh(shared.box, mat(look.jersey));
    const tdir = new THREE.Vector3().subVectors(shoulder, hip);
    torso.position.copy(hip).addScaledVector(tdir, 0.5);
    torso.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tdir.clone().normalize());
    torso.scale.set(0.34, 0.2, tdir.length() + 0.06);
    this.body.add(torso);
    const pelvis = new THREE.Mesh(shared.box, mat(look.shorts ?? '#1a1a1a'));
    pelvis.scale.set(0.3, 0.18, 0.22);
    pelvis.position.copy(hip);
    this.body.add(pelvis);

    const head = new THREE.Mesh(shared.sphere, mat(skin));
    head.scale.setScalar(0.11);
    head.position.set(0, 1.55, 0.42);
    this.body.add(head);
    const helmet = new THREE.Mesh(shared.sphere, mat(look.helmet ?? '#f2f2f2'));
    helmet.scale.set(0.13, 0.09, 0.16);
    helmet.position.set(0, 1.61, 0.4);
    this.body.add(helmet);

    for (const side of [-1, 1]) {
      const sh = shoulder.clone().setX(side * 0.17);
      const hand = new THREE.Vector3(side * 0.2, 0.96, 0.5);
      const elbow = sh.clone().lerp(hand, 0.5).add(new THREE.Vector3(side * 0.05, 0.02, -0.05));
      const up: Limb = { mesh: new THREE.Mesh(shared.limb, mat(look.jersey)) };
      const lo: Limb = { mesh: new THREE.Mesh(shared.limb, mat(skin)) };
      placeLimb(up, sh, elbow, 0.045);
      placeLimb(lo, elbow, hand, 0.035);
      this.body.add(up.mesh, lo.mesh);

      const thigh: Limb = { mesh: new THREE.Mesh(shared.limb, mat(look.shorts ?? '#1a1a1a')) };
      const shin: Limb = { mesh: new THREE.Mesh(shared.limb, mat(skin)) };
      const foot = new THREE.Mesh(shared.box, mat('#222'));
      foot.scale.set(0.08, 0.06, 0.22);
      this.body.add(thigh.mesh, shin.mesh, foot);
      this.legs.push({ thigh, shin, foot, side });
    }
    this.mergeStatic();
    this.pose();
  }

  /**
   * Bake every non-animated part (frame, torso, arms, head...) into a single
   * vertex-coloured mesh, and each wheel into one mesh: ~10 draw calls per
   * rider instead of ~35.
   */
  private mergeStatic() {
    const animated = new Set<THREE.Object3D>([this.crank, ...this.wheels]);
    for (const l of this.legs) animated.add(l.thigh.mesh).add(l.shin.mesh).add(l.foot);
    const bake = (meshes: THREE.Mesh[], parentInv?: THREE.Matrix4) => {
      const parts = meshes.map((m) => {
        m.updateMatrix();
        let g = m.geometry.clone().applyMatrix4(m.matrix);
        if (parentInv) g.applyMatrix4(parentInv);
        if (g.index) g = g.toNonIndexed();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        const c = (m.material as THREE.MeshLambertMaterial).color;
        const arr = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        return g;
      });
      return new THREE.Mesh(mergeGeometries(parts)!, vertexMat);
    };
    const stat = this.body.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh && !animated.has(o));
    for (const m of stat) this.body.remove(m);
    this.body.add(bake(stat));
    this.wheels = this.wheels.map((w) => {
      const parts = w.children as THREE.Mesh[];
      const baked = bake(parts);
      baked.position.copy(w.position);
      this.body.remove(w);
      this.body.add(baked);
      return baked;
    });
  }

  /** Advance animation by dt using cadence (rpm) and road speed (m/s). */
  update(dt: number, cadenceRpm: number, speed: number) {
    this.crankAngle += (cadenceRpm / 60) * Math.PI * 2 * dt;
    this.wheelAngle += (speed / 0.34) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelAngle;
    this.crank.rotation.x = this.crankAngle;
    // Slight side-to-side rock at higher cadence/effort.
    this.body.rotation.z = Math.sin(this.crankAngle) * 0.025 * Math.min(1, cadenceRpm / 60);
    this.pose();
  }

  private pose() {
    const hipY = 1.0;
    const hipZ = -0.15;
    const A = 0.47; // thigh
    const B = 0.47; // shin
    const crankLen = 0.17;
    for (const leg of this.legs) {
      const a = this.crankAngle + (leg.side > 0 ? 0 : Math.PI);
      const pedal = new THREE.Vector3(leg.side * 0.11, 0.3 - Math.cos(a) * crankLen, Math.sin(a) * crankLen);
      const hip = new THREE.Vector3(leg.side * 0.1, hipY, hipZ);
      const d = new THREE.Vector3().subVectors(pedal, hip);
      const dist = Math.min(d.length(), A + B - 0.001);
      // Angle between hip->pedal and the thigh (law of cosines).
      const alpha = Math.acos((A * A + dist * dist - B * B) / (2 * A * dist));
      // Rotate hip->pedal direction toward +Z (knee forward) by alpha in the YZ plane.
      const base = Math.atan2(d.z, -d.y); // angle from straight-down toward +z
      const th = base + alpha;
      const knee = new THREE.Vector3(hip.x, hip.y - Math.cos(th) * A, hip.z + Math.sin(th) * A);
      placeLimb(leg.thigh, hip, knee, 0.065);
      placeLimb(leg.shin, knee, pedal, 0.045);
      leg.foot.position.copy(pedal).add(new THREE.Vector3(0, 0.02, 0.04));
    }
  }
}
