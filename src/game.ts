import * as THREE from 'three';
import { Route } from './world/route';
import { World } from './world/world';
import { RiderModel } from './world/rider';
import { DEFAULT_PARAMS, RiderParams, stepSpeed } from './sim/physics';
import type { Quality } from './settings';

export type CameraMode = 'chase' | 'far' | 'side' | 'first';
export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'side', 'first'];

export interface QualityProfile {
  /** Internal render height in pixels (null = native). */
  renderHeight: number | null;
  maxPixelRatio: number;
  terrainStep: number;
  trees: number;
  fogFar: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  // ~PS2 framebuffer height, nearest-neighbour upscaled.
  ps2: { renderHeight: 448, maxPixelRatio: 1, terrainStep: 28, trees: 1400, fogFar: 2200 },
  low: { renderHeight: 360, maxPixelRatio: 1, terrainStep: 40, trees: 600, fogFar: 1500 },
  high: { renderHeight: null, maxPixelRatio: 2, terrainStep: 20, trees: 2600, fogFar: 3000 },
};

export interface RiderState {
  name: string;
  distance: number; // total metres travelled (not wrapped)
  speed: number; // m/s
  power: number;
  cadence: number;
  model: RiderModel;
  lane: number; // lateral offset, metres (+ = right)
  isPlayer: boolean;
  drafting: number; // 0..1 how much draft benefit
}

interface Bot extends RiderState {
  basePower: number;
  phase: number;
}

const BOT_DEFS = [
  { name: 'Ana · 2.5 w/kg', wkg: 2.5, jersey: '#2c7be5', helmet: '#2c7be5' },
  { name: 'Ben · 3.0 w/kg', wkg: 3.0, jersey: '#f2b705', helmet: '#222' },
  { name: 'Chen · 3.5 w/kg', wkg: 3.5, jersey: '#22a36b', helmet: '#fff' },
  { name: 'Dara · 4.2 w/kg', wkg: 4.2, jersey: '#9b4dca', helmet: '#9b4dca' },
];

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly route: Route;
  readonly world: World;
  readonly player: RiderState;
  readonly bots: Bot[] = [];
  cameraMode: CameraMode = 'chase';
  params: RiderParams = { ...DEFAULT_PARAMS };
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  private tmp = { x: 0, y: 0, z: 0 };
  private frameTimes: number[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    route: Route,
    private quality: QualityProfile,
    opts: { jersey: string; bots: boolean; riderKg: number },
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 9000);
    this.route = route;
    this.world = new World(route, { terrainStep: quality.terrainStep, trees: quality.trees });
    (this.world.scene.fog as THREE.Fog).far = quality.fogFar;

    const model = new RiderModel({ jersey: opts.jersey, helmet: '#ffffff' });
    this.world.scene.add(model.root);
    this.player = {
      name: 'You',
      distance: 0,
      speed: 0,
      power: 0,
      cadence: 0,
      model,
      lane: 1.4,
      isPlayer: true,
      drafting: 0,
    };

    if (opts.bots) {
      BOT_DEFS.forEach((b, i) => {
        const m = new RiderModel({ jersey: b.jersey, helmet: b.helmet, bike: i % 2 ? '#b8b8b8' : '#202428' });
        this.world.scene.add(m.root);
        this.bots.push({
          name: b.name,
          distance: 15 + i * 12,
          speed: 6,
          power: 0,
          cadence: 88,
          model: m,
          lane: -1.4 + (i % 2) * 1.2,
          isPlayer: false,
          drafting: 0,
          basePower: b.wkg * opts.riderKg,
          phase: i * 1.7,
        });
      });
    }
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    let ratio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    if (this.quality.renderHeight) ratio = Math.min(ratio, this.quality.renderHeight / h);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Advance simulation.
   * @param dt seconds
   * @param power player's power in watts
   * @param cadence player's cadence in rpm (for animation)
   */
  update(dt: number, power: number, cadence: number, t: number) {
    const p = this.player;
    p.power = power;
    p.cadence = cadence;

    // Draft: being 0.5–10 m behind another rider cuts aero drag by up to ~30%.
    const draftFor = (r: RiderState) => {
      let best = 0;
      for (const o of [this.player, ...this.bots]) {
        if (o === r) continue;
        const gap = this.gap(o.distance, r.distance);
        if (gap > 0.5 && gap < 10) best = Math.max(best, 1 - (gap - 0.5) / 9.5);
      }
      return best;
    };

    const steps = Math.max(1, Math.ceil(dt / 0.05));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      p.drafting = draftFor(p);
      const grade = this.route.gradeAt(p.distance);
      p.speed = stepSpeed(p.speed, power, grade, h, this.params, 1 - 0.3 * p.drafting);
      p.distance += p.speed * h;

      for (const b of this.bots) {
        b.drafting = draftFor(b);
        const g = this.route.gradeAt(b.distance);
        // Bots push a bit harder uphill and ease off downhill, like humans.
        const surge = 1 + 0.06 * Math.sin(t * 0.05 + b.phase);
        b.power = Math.max(0, b.basePower * surge * (1 + Math.max(-0.6, Math.min(0.25, g * 0.04))));
        b.speed = stepSpeed(b.speed, b.power, g, h, this.params, 1 - 0.3 * b.drafting);
        b.distance += b.speed * h;
        b.cadence = b.power > 20 ? 85 + Math.sin(t * 0.3 + b.phase) * 5 : 0;
      }
    }

    for (const r of [p, ...this.bots]) this.placeRider(r, dt);
    this.updateCamera(dt);
  }

  /** Signed gap in metres from b to a along the loop (positive = a ahead). */
  gap(a: number, b: number): number {
    const L = this.route.length;
    let d = (a - b) % L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  }

  private placeRider(r: RiderState, dt: number) {
    const route = this.route;
    const pt = route.pointAt(r.distance, this.tmp);
    const hd = route.headingAt(r.distance);
    const rx = Math.cos(hd);
    const rz = -Math.sin(hd);
    r.model.root.position.set(pt.x + rx * r.lane, pt.y + 0.05, pt.z + rz * r.lane);
    r.model.root.rotation.set(0, 0, 0);
    r.model.root.rotation.order = 'YXZ';
    r.model.root.rotation.y = hd;
    r.model.root.rotation.x = -Math.atan(route.gradeAt(r.distance) / 100);
    r.model.update(dt, r.cadence, r.speed);
  }

  private updateCamera(dt: number) {
    const p = this.player;
    const route = this.route;
    const pp = p.model.root.position;
    const desired = new THREE.Vector3();
    const look = new THREE.Vector3();
    const hd = route.headingAt(p.distance);
    const rx = Math.cos(hd);
    const rz = -Math.sin(hd);
    const ahead = route.pointAt(p.distance + 12);
    switch (this.cameraMode) {
      case 'chase': {
        const b = route.pointAt(p.distance - 5.5);
        desired.set(b.x + rx * p.lane, Math.max(b.y, pp.y) + 2.1, b.z + rz * p.lane);
        look.set(ahead.x + rx * p.lane * 0.5, ahead.y + 0.8, ahead.z + rz * p.lane * 0.5);
        break;
      }
      case 'far': {
        const b = route.pointAt(p.distance - 16);
        desired.set(b.x + rx * p.lane, Math.max(b.y, pp.y) + 6, b.z + rz * p.lane);
        look.set(pp.x, pp.y + 1, pp.z);
        break;
      }
      case 'side': {
        desired.set(pp.x + rx * 5, pp.y + 1.3, pp.z + rz * 5);
        look.set(pp.x, pp.y + 0.9, pp.z);
        break;
      }
      case 'first': {
        desired.set(pp.x, pp.y + 1.65, pp.z).addScaledVector(new THREE.Vector3(Math.sin(hd), 0, Math.cos(hd)), 0.4);
        look.set(ahead.x + rx * p.lane, ahead.y + 1.4, ahead.z + rz * p.lane);
        break;
      }
    }
    if (!this.camInit) {
      this.camPos.copy(desired);
      this.camLook.copy(look);
      this.camInit = true;
    }
    const k = this.cameraMode === 'first' ? 1 : 1 - Math.exp(-dt * 4);
    this.camPos.lerp(desired, k);
    this.camLook.lerp(look, this.cameraMode === 'first' ? 1 : 1 - Math.exp(-dt * 6));
    // Never let the chase camera dip below the terrain.
    const ground = this.world.terrainHeight(this.camPos.x, this.camPos.z) + 0.8;
    if (this.camPos.y < ground) this.camPos.y = ground;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // Keep sky + sun centred on the camera.
    const sky = this.world.scene.getObjectByName('sky');
    if (sky) sky.position.copy(this.camPos);
  }

  render() {
    const t0 = performance.now();
    this.renderer.render(this.world.scene, this.camera);
    this.frameTimes.push(performance.now() - t0);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }

  stats() {
    const info = this.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles };
  }

  /** Riders sorted by position relative to the player (for the HUD list). */
  standings(): { name: string; gap: number; isPlayer: boolean; power: number }[] {
    return [this.player, ...this.bots]
      .map((r) => ({ name: r.name, gap: this.gap(r.distance, this.player.distance), isPlayer: r.isPlayer, power: r.power }))
      .sort((a, b) => b.gap - a.gap);
  }

  dispose() {
    this.world.dispose();
    this.renderer.dispose();
  }
}
