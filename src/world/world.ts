import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Route, mulberry32 } from './route';
import { makeBannerTexture, makeBarkTexture, makeGrassTexture, makeRoadTexture } from './textures';

const ROAD_HALF_WIDTH = 4;

/** Cheap value noise + fbm, deterministic. */
function makeNoise(seed: number) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rnd() * 2 - 1;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const v = (x: number, y: number) => vals[perm[(x & 255) + perm[y & 255]]];
  const sm = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = sm(x - xi);
    const yf = sm(y - yi);
    const a = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * xf;
    const b = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * xf;
    return a + (b - a) * yf;
  };
  return (x: number, y: number, oct = 4) => {
    let s = 0;
    let a = 1;
    let f = 1;
    let n = 0;
    for (let o = 0; o < oct; o++) {
      s += noise(x * f, y * f) * a;
      n += a;
      a *= 0.5;
      f *= 2.03;
    }
    return s / n;
  };
}

/** Spatial hash over the road samples for fast nearest-road queries. */
class RoadIndex {
  private cells = new Map<number, number[]>();
  constructor(private route: Route, private cell = 64) {
    for (let i = 0; i < route.count; i += 2) {
      const k = this.key(route.xs[i], route.zs[i]);
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    }
  }
  private key(x: number, z: number) {
    return this.ckey(Math.floor(x / this.cell), Math.floor(z / this.cell));
  }
  private ckey(cx: number, cz: number) {
    return (cx + 5000) * 10000 + (cz + 5000);
  }
  /** Returns [distance, road height] of nearest road sample within ~2 cells, or [Infinity, NaN]. */
  nearest(x: number, z: number, rings = 2): [number, number] {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = Infinity;
    let bi = -1;
    for (let dx = -rings; dx <= rings; dx++) {
      for (let dz = -rings; dz <= rings; dz++) {
        const c = this.cells.get(this.ckey(cx + dx, cz + dz));
        if (!c) continue;
        for (const i of c) {
          const d = (this.route.xs[i] - x) ** 2 + (this.route.zs[i] - z) ** 2;
          if (d < best) {
            best = d;
            bi = i;
          }
        }
      }
    }
    return bi < 0 ? [Infinity, NaN] : [Math.sqrt(best), this.route.ys[bi]];
  }
}

export interface WorldOptions {
  /** Grid spacing of terrain (bigger = cheaper). */
  terrainStep: number;
  trees: number;
}

export class World {
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  readonly waterLevel: number;
  private noise: ReturnType<typeof makeNoise>;
  private roadIndex: RoadIndex;
  private disposables: { dispose(): void }[] = [];

  constructor(readonly route: Route, opts: WorldOptions) {
    this.noise = makeNoise(route.def.seed * 31 + 1);
    this.roadIndex = new RoadIndex(route);
    this.waterLevel = route.minY - 6;

    const skyColor = new THREE.Color('#9cc7e8');
    this.scene.background = skyColor;
    this.scene.fog = new THREE.Fog(skyColor, 250, 2200);

    this.scene.add(new THREE.HemisphereLight('#dfefff', '#4a5a2a', 1.6));
    this.sun = new THREE.DirectionalLight('#fff3d6', 2.2);
    this.sun.position.set(0.5, 1, 0.3).multiplyScalar(1000);
    this.scene.add(this.sun);

    this.buildSky();
    this.buildTerrain(opts.terrainStep);
    this.buildRoad();
    this.buildWater();
    this.buildTrees(opts.trees);
    this.buildRocks(Math.round(opts.trees / 5));
    this.buildMountains();
    this.buildArches();
    this.buildHouses();
    this.buildClouds();
  }

  private track<T extends { dispose(): void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Terrain height at world x,z (matches the mesh at the vertices). */
  terrainHeight(x: number, z: number): number {
    const [d, roadY] = this.roadIndex.nearest(x, z, 3);
    const n = this.noise(x / 700, z / 700, 4);
    const hills = n * 140 + this.noise(x / 160, z / 160, 3) * 18;
    const base = this.route.minY + 8 + hills;
    if (!isFinite(d)) return base;
    // Flatten a corridor around the road (slightly below road level so the
    // coarse terrain grid never pokes through) and blend out to natural hills.
    const corridor = ROAD_HALF_WIDTH + 22;
    const flat = roadY - 0.6;
    if (d < corridor) return flat;
    const t = THREE.MathUtils.smoothstep(d, corridor, 180);
    return flat + (base - flat) * t;
  }

  private bounds() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.route.count; i++) {
      minX = Math.min(minX, this.route.xs[i]);
      maxX = Math.max(maxX, this.route.xs[i]);
      minZ = Math.min(minZ, this.route.zs[i]);
      maxZ = Math.max(maxZ, this.route.zs[i]);
    }
    const m = 1400;
    return { minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m };
  }

  private buildSky() {
    const geo = this.track(new THREE.SphereGeometry(6000, 16, 10));
    const colors: number[] = [];
    const top = new THREE.Color('#3f7fc8');
    const horizon = new THREE.Color('#9cc7e8');
    const pos = geo.attributes.position;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 6000;
      c.copy(horizon).lerp(top, Math.max(0, Math.min(1, y * 2.2)));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = this.track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    sky.name = 'sky';
    this.scene.add(sky);
  }

  private buildTerrain(step: number) {
    const b = this.bounds();
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    // Cap vertex count so huge routes stay cheap on phones.
    step = Math.max(step, Math.max(w, h) / 220);
    const nx = Math.ceil(w / step);
    const nz = Math.ceil(h / step);
    const vx = nx + 1;
    const vz = nz + 1;

    // 1. Sample the heightfield + vertex colours once for the whole grid.
    const H = new Float32Array(vx * vz);
    const C = new Float32Array(vx * vz * 3);
    const grass = new THREE.Color('#6f9a3a');
    const dry = new THREE.Color('#a5a35a');
    const rock = new THREE.Color('#8a8478');
    const snow = new THREE.Color('#f4f6f8');
    const sand = new THREE.Color('#d8c890');
    const c = new THREE.Color();
    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const x = b.minX + i * step;
        const z = b.minZ + j * step;
        const y = this.terrainHeight(x, z);
        const k = j * vx + i;
        H[k] = y;
        const n = this.noise(x / 90, z / 90, 2);
        c.copy(grass).lerp(dry, Math.max(0, Math.min(1, n * 1.5 + 0.2)));
        const rel = y - this.route.maxY;
        if (rel > 20) c.lerp(rock, Math.min(1, (rel - 20) / 40));
        if (rel > 75) c.lerp(snow, Math.min(1, (rel - 75) / 20));
        if (y < this.waterLevel + 2) c.lerp(sand, 0.8);
        C[k * 3] = c.r;
        C[k * 3 + 1] = c.g;
        C[k * 3 + 2] = c.b;
      }
    }
    // Normals from central differences so chunk seams shade identically.
    const N = new Float32Array(vx * vz * 3);
    const v = new THREE.Vector3();
    for (let j = 0; j < vz; j++) {
      for (let i = 0; i < vx; i++) {
        const hl = H[j * vx + Math.max(0, i - 1)];
        const hr = H[j * vx + Math.min(vx - 1, i + 1)];
        const hd = H[Math.max(0, j - 1) * vx + i];
        const hu = H[Math.min(vz - 1, j + 1) * vx + i];
        v.set(hl - hr, 2 * step, hd - hu).normalize();
        N.set([v.x, v.y, v.z], (j * vx + i) * 3);
      }
    }

    // 2. Split into chunks so the GPU only draws what's in view.
    const tex = this.track(makeGrassTexture());
    const mat = this.track(new THREE.MeshLambertMaterial({ vertexColors: true, map: tex }));
    const CH = 32;
    for (let cj = 0; cj < nz; cj += CH) {
      for (let ci = 0; ci < nx; ci += CH) {
        const cw = Math.min(CH, nx - ci);
        const cd = Math.min(CH, nz - cj);
        const pos = new Float32Array((cw + 1) * (cd + 1) * 3);
        const col = new Float32Array((cw + 1) * (cd + 1) * 3);
        const nor = new Float32Array((cw + 1) * (cd + 1) * 3);
        const uv = new Float32Array((cw + 1) * (cd + 1) * 2);
        let o = 0;
        for (let j = 0; j <= cd; j++) {
          for (let i = 0; i <= cw; i++) {
            const gi = ci + i;
            const gj = cj + j;
            const k = gj * vx + gi;
            const x = b.minX + gi * step;
            const z = b.minZ + gj * step;
            pos.set([x, H[k], z], o * 3);
            col.set([C[k * 3], C[k * 3 + 1], C[k * 3 + 2]], o * 3);
            nor.set([N[k * 3], N[k * 3 + 1], N[k * 3 + 2]], o * 3);
            uv.set([x / 6, z / 6], o * 2);
            o++;
          }
        }
        const idx: number[] = [];
        for (let j = 0; j < cd; j++) {
          for (let i = 0; i < cw; i++) {
            const a0 = j * (cw + 1) + i;
            const a1 = a0 + 1;
            const b0 = a0 + cw + 1;
            const b1 = b0 + 1;
            idx.push(a0, b0, a1, a1, b0, b1);
          }
        }
        const geo = this.track(new THREE.BufferGeometry());
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = 'terrain';
        this.scene.add(mesh);
      }
    }
  }

  private buildRoad() {
    const r = this.route;
    const stride = 2; // every 4 m
    const n = Math.floor(r.count / stride);
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const shoulderPos: number[] = [];
    const shoulderIdx: number[] = [];
    for (let k = 0; k <= n; k++) {
      const i = (k * stride) % r.count;
      const d = i * r.step;
      const p = r.pointAt(d);
      const hd = r.headingAt(d);
      // Right vector perpendicular to heading in XZ.
      const rx = Math.cos(hd);
      const rz = -Math.sin(hd);
      const y = p.y + 0.05;
      pos.push(p.x - rx * ROAD_HALF_WIDTH, y, p.z - rz * ROAD_HALF_WIDTH, p.x + rx * ROAD_HALF_WIDTH, y, p.z + rz * ROAD_HALF_WIDTH);
      const v = (k * stride * r.step) / 8;
      uv.push(0, v, 1, v);
      const sw = ROAD_HALF_WIDTH + 1.2;
      shoulderPos.push(
        p.x - rx * sw, p.y - 0.15, p.z - rz * sw,
        p.x - rx * ROAD_HALF_WIDTH, y - 0.02, p.z - rz * ROAD_HALF_WIDTH,
        p.x + rx * ROAD_HALF_WIDTH, y - 0.02, p.z + rz * ROAD_HALF_WIDTH,
        p.x + rx * sw, p.y - 0.15, p.z + rz * sw,
      );
      if (k < n) {
        const a = k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        const s = k * 4;
        shoulderIdx.push(s, s + 4, s + 1, s + 1, s + 4, s + 5, s + 2, s + 6, s + 3, s + 3, s + 6, s + 7);
      }
    }
    const geo = this.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = this.track(makeRoadTexture());
    const mat = this.track(
      new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    const road = new THREE.Mesh(geo, mat);
    road.name = 'road';
    this.scene.add(road);

    const sg = this.track(new THREE.BufferGeometry());
    sg.setAttribute('position', new THREE.Float32BufferAttribute(shoulderPos, 3));
    sg.setIndex(shoulderIdx);
    sg.computeVertexNormals();
    const sm = this.track(new THREE.MeshLambertMaterial({ color: '#9c8d6c', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    this.scene.add(new THREE.Mesh(sg, sm));
  }

  private buildWater() {
    const geo = this.track(new THREE.PlaneGeometry(20000, 20000, 1, 1));
    geo.rotateX(-Math.PI / 2);
    const mat = this.track(new THREE.MeshLambertMaterial({ color: '#3b78a8', transparent: true, opacity: 0.85 }));
    const water = new THREE.Mesh(geo, mat);
    water.position.y = this.waterLevel;
    water.name = 'water';
    this.scene.add(water);
  }

  /** Random point on land, away from the road. */
  private scatter(rnd: () => number, minRoad: number, maxRoad: number): THREE.Vector3 | null {
    const b = this.bounds();
    for (let tries = 0; tries < 30; tries++) {
      // Bias placement toward the road where the rider can see it.
      const i = Math.floor(rnd() * this.route.count);
      const ang = rnd() * Math.PI * 2;
      const dist = minRoad + Math.pow(rnd(), 1.6) * (maxRoad - minRoad);
      const x = this.route.xs[i] + Math.cos(ang) * dist;
      const z = this.route.zs[i] + Math.sin(ang) * dist;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const [d] = this.roadIndex.nearest(x, z, 1);
      if (d < minRoad) continue;
      const y = this.terrainHeight(x, z);
      if (y < this.waterLevel + 1.5) continue;
      if (y - this.route.maxY > 70) continue; // no trees above treeline
      return new THREE.Vector3(x, y, z);
    }
    return null;
  }

  private buildTrees(count: number) {
    const rnd = mulberry32(this.route.def.seed + 1000);
    const colorize = (g: THREE.BufferGeometry, col: string) => {
      const c = new THREE.Color(col);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      g.deleteAttribute('uv');
      return g.index ? g.toNonIndexed() : g;
    };
    // Pine: trunk + two stacked cones. Deciduous: trunk + low-poly blob.
    const trunk = () => colorize(new THREE.CylinderGeometry(0.25, 0.35, 2, 5).translate(0, 1, 0), '#6b4a2f');
    const pine = mergeGeometries([
      trunk(),
      colorize(new THREE.ConeGeometry(2.4, 4.5, 6).translate(0, 3.8, 0), '#2f5d34'),
      colorize(new THREE.ConeGeometry(1.7, 3.5, 6).translate(0, 6.2, 0), '#3a6e3c'),
    ])!;
    const leafy = mergeGeometries([
      trunk(),
      colorize(new THREE.IcosahedronGeometry(2.6, 0).translate(0, 4, 0), '#5d8a35'),
    ])!;
    this.track(pine);
    this.track(leafy);
    const mat = this.track(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.track(makeBarkTexture());

    const make = (geo: THREE.BufferGeometry, n: number) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const tint = new THREE.Color();
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const p = this.scatter(rnd, ROAD_HALF_WIDTH + 6, 700);
        if (!p) continue;
        const k = 0.7 + rnd() * 0.8;
        s.set(k, k * (0.85 + rnd() * 0.4), k);
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
        p.y -= 0.3;
        m.compose(p, q, s);
        mesh.setMatrixAt(placed, m);
        tint.setHSL(0, 0, 0.8 + rnd() * 0.35);
        mesh.setColorAt(placed, tint);
        placed++;
      }
      mesh.count = placed;
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    };
    make(pine, Math.round(count * 0.6));
    make(leafy, Math.round(count * 0.4));
  }

  private buildRocks(count: number) {
    const rnd = mulberry32(this.route.def.seed + 2000);
    const geo = this.track(new THREE.DodecahedronGeometry(1, 0));
    const mat = this.track(new THREE.MeshLambertMaterial({ color: '#8f8a80', flatShading: true }));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    let placed = 0;
    for (let i = 0; i < count; i++) {
      const p = this.scatter(rnd, ROAD_HALF_WIDTH + 3, 400);
      if (!p) continue;
      const k = 0.4 + rnd() * 1.6;
      s.set(k * (1 + rnd()), k * 0.7, k);
      q.setFromEuler(e.set(rnd(), rnd() * 6, rnd()));
      m.compose(p, q, s);
      mesh.setMatrixAt(placed++, m);
    }
    mesh.count = placed;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
  }

  private buildMountains() {
    // Distant ring of low-poly peaks with snow caps. Not affected by fog much.
    const rnd = mulberry32(this.route.def.seed + 3000);
    const parts: THREE.BufferGeometry[] = [];
    const rock = new THREE.Color('#6d7a8c');
    const snow = new THREE.Color('#f5f7fa');
    const R = this.route.def.radius * 1.6 + 2200;
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + rnd() * 0.1;
      const r = R + rnd() * 900;
      const hgt = 380 + rnd() * 650;
      const g = new THREE.ConeGeometry(500 + rnd() * 500, hgt, 6 + Math.floor(rnd() * 3), 3);
      g.deleteAttribute('uv');
      const p = g.attributes.position;
      const cols = new Float32Array(p.count * 3);
      const c = new THREE.Color();
      for (let v = 0; v < p.count; v++) {
        const y = p.getY(v) / hgt + 0.5;
        // Jitter non-apex verts for a craggy silhouette.
        if (y < 0.99 && y > 0.01) {
          p.setX(v, p.getX(v) * (0.8 + rnd() * 0.4));
          p.setZ(v, p.getZ(v) * (0.8 + rnd() * 0.4));
        }
        c.copy(rock).lerp(snow, y > 0.62 ? 1 : 0);
        cols[v * 3] = c.r;
        cols[v * 3 + 1] = c.g;
        cols[v * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      g.translate(Math.cos(a) * r, hgt / 2 + this.route.minY - 30, Math.sin(a) * r);
      parts.push(g.toNonIndexed());
    }
    const geo = this.track(mergeGeometries(parts)!);
    geo.computeVertexNormals();
    const mat = this.track(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'mountains';
    this.scene.add(mesh);
  }

  private buildArch(d: number, text: string, bg: string, fg: string) {
    const r = this.route;
    const p = r.pointAt(d);
    const hd = r.headingAt(d);
    const g = new THREE.Group();
    const postGeo = this.track(new THREE.BoxGeometry(0.5, 6, 0.5));
    const postMat = this.track(new THREE.MeshLambertMaterial({ color: bg }));
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(side * (ROAD_HALF_WIDTH + 1), 3, 0);
      g.add(post);
    }
    const tex = this.track(makeBannerTexture(text, bg, fg));
    const bannerMat = this.track(new THREE.MeshLambertMaterial({ map: tex }));
    const banner = new THREE.Mesh(this.track(new THREE.BoxGeometry(2 * ROAD_HALF_WIDTH + 2.5, 1.2, 0.3)), [
      postMat, postMat, postMat, postMat, bannerMat, bannerMat,
    ]);
    banner.position.y = 5.6;
    g.add(banner);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = hd;
    this.scene.add(g);
  }

  private buildArches() {
    this.buildArch(0, 'START / FINISH', '#1b1b1b', '#ffffff');
    this.buildArch(this.route.summitDistance(), 'KOM', '#c8102e', '#ffffff');
  }

  private buildHouses() {
    const rnd = mulberry32(this.route.def.seed + 4000);
    const walls = ['#e8dcc0', '#d9b48f', '#f2efe6', '#c9d6df'];
    const roofs = ['#8b3a2b', '#5a4a3a', '#3d4f63'];
    const parts: THREE.BufferGeometry[] = [];
    const paint = (g: THREE.BufferGeometry, col: string) => {
      const c = new THREE.Color(col);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      g.deleteAttribute('uv');
      return g.index ? g.toNonIndexed() : g;
    };
    // A few hamlets along the road.
    for (let v = 0; v < 5; v++) {
      const d = rnd() * this.route.length;
      for (let hIdx = 0; hIdx < 4 + Math.floor(rnd() * 4); hIdx++) {
        const dd = d + (rnd() - 0.5) * 160;
        const p = this.route.pointAt(dd);
        const hd = this.route.headingAt(dd);
        const side = rnd() < 0.5 ? -1 : 1;
        const off = ROAD_HALF_WIDTH + 10 + rnd() * 18;
        const x = p.x + Math.cos(hd) * off * side;
        const z = p.z - Math.sin(hd) * off * side;
        const y = this.terrainHeight(x, z);
        const w = 6 + rnd() * 4;
        const dep = 7 + rnd() * 5;
        const ht = 3 + rnd() * 2;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, hd),
          new THREE.Vector3(1, 1, 1),
        );
        const body = paint(new THREE.BoxGeometry(w, ht + 2, dep).translate(0, (ht + 2) / 2 - 2, 0), walls[Math.floor(rnd() * walls.length)]);
        const roof = paint(
          new THREE.CylinderGeometry(0.01, w * 0.62, 2.4, 4, 1).rotateY(Math.PI / 4).scale(1, 1, dep / w).translate(0, ht + 1.2, 0),
          roofs[Math.floor(rnd() * roofs.length)],
        );
        parts.push(body.applyMatrix4(m), roof.applyMatrix4(m));
      }
    }
    const geo = this.track(mergeGeometries(parts)!);
    geo.computeVertexNormals();
    const mat = this.track(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  private buildClouds() {
    const rnd = mulberry32(this.route.def.seed + 5000);
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 24; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 800 + rnd() * 3000;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const cy = this.route.maxY + 350 + rnd() * 250;
      for (let k = 0; k < 4; k++) {
        const s = 40 + rnd() * 60;
        const g = new THREE.IcosahedronGeometry(1, 0);
        g.scale(s * 1.6, s * 0.6, s);
        // Shade bottoms slightly blue-grey for volume without lighting cost.
        const pa = g.attributes.position;
        const col = new Float32Array(pa.count * 3);
        for (let v = 0; v < pa.count; v++) {
          const t = Math.max(0, Math.min(1, pa.getY(v) / (s * 0.6) * 0.5 + 0.5));
          col.set([0.78 + 0.22 * t, 0.83 + 0.17 * t, 0.9 + 0.1 * t], v * 3);
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.translate(cx + (rnd() - 0.5) * 160, cy + rnd() * 20, cz + (rnd() - 0.5) * 100);
        g.deleteAttribute('uv');
        parts.push(g);
      }
    }
    const geo = this.track(mergeGeometries(parts)!);
    const mat = this.track(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    this.scene.add(new THREE.Mesh(geo, mat));
  }
}
