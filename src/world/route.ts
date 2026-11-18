/**
 * Procedurally generated closed-loop route. All geometry is derived from a
 * seed so the same world is produced every time with zero asset downloads.
 */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RoutePoint {
  x: number;
  y: number;
  z: number;
}

export interface RouteDef {
  name: string;
  seed: number;
  radius: number; // rough loop radius in metres
  hilliness: number; // multiplier on elevation amplitude
}

export const ROUTES: RouteDef[] = [
  { name: 'Lakeside Loop', seed: 7, radius: 900, hilliness: 0.6 },
  { name: 'Pine Ridge Circuit', seed: 21, radius: 1300, hilliness: 1.0 },
  { name: 'Alpine Grinder', seed: 99, radius: 1600, hilliness: 1.5 },
];

export class Route {
  /** Sample spacing along the road, metres. */
  readonly step = 2;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  readonly length: number;
  readonly count: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(readonly def: RouteDef) {
    const rnd = mulberry32(def.seed);
    const ph = Array.from({ length: 8 }, () => rnd() * Math.PI * 2);
    const amp = [0.22 + rnd() * 0.1, 0.1 + rnd() * 0.08, 0.04 + rnd() * 0.04];

    // 1. Dense polar curve -> arc-length table.
    const N = 4000;
    const px: number[] = [];
    const pz: number[] = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      const r =
        def.radius *
        (1 + amp[0] * Math.sin(2 * t + ph[0]) + amp[1] * Math.sin(3 * t + ph[1]) + amp[2] * Math.sin(5 * t + ph[2]));
      px.push(Math.cos(t) * r);
      pz.push(Math.sin(t) * r);
    }
    const cum = [0];
    for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]));
    const total = cum[N];

    // 2. Resample at uniform spacing.
    this.count = Math.floor(total / this.step);
    this.length = this.count * this.step;
    this.xs = new Float32Array(this.count);
    this.ys = new Float32Array(this.count);
    this.zs = new Float32Array(this.count);
    let j = 0;
    const scale = total / this.length;
    for (let i = 0; i < this.count; i++) {
      const d = i * this.step * scale;
      while (j < N - 1 && cum[j + 1] < d) j++;
      const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
      this.xs[i] = px[j] + (px[j + 1] - px[j]) * f;
      this.zs[i] = pz[j] + (pz[j + 1] - pz[j]) * f;
    }

    // 3. Periodic elevation profile (loop closes because every term is periodic).
    //    Each harmonic is scaled so its max gradient stays sensible.
    const L = this.length;
    const harmonics = [1, 2, 3, 5, 8];
    const maxGradeEach = [0.025, 0.025, 0.02, 0.015, 0.012].map((g) => g * def.hilliness);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const s = (i * this.step) / L;
      let y = 0;
      for (let k = 0; k < harmonics.length; k++) {
        const n = harmonics[k];
        const a = (maxGradeEach[k] * L) / (2 * Math.PI * n);
        y += a * Math.sin(2 * Math.PI * n * s + ph[3 + k]);
      }
      this.ys[i] = y;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    // Lift so the lowest point is at 20 m.
    for (let i = 0; i < this.count; i++) this.ys[i] += 20 - minY;
    this.minY = 20;
    this.maxY = maxY - minY + 20;
  }

  private idx(i: number) {
    return ((i % this.count) + this.count) % this.count;
  }

  wrap(d: number): number {
    return ((d % this.length) + this.length) % this.length;
  }

  /** Position on the centre line at distance d (wraps around). */
  pointAt(d: number, out: RoutePoint = { x: 0, y: 0, z: 0 }): RoutePoint {
    const f = this.wrap(d) / this.step;
    const i = Math.floor(f);
    const t = f - i;
    const a = this.idx(i);
    const b = this.idx(i + 1);
    out.x = this.xs[a] + (this.xs[b] - this.xs[a]) * t;
    out.y = this.ys[a] + (this.ys[b] - this.ys[a]) * t;
    out.z = this.zs[a] + (this.zs[b] - this.zs[a]) * t;
    return out;
  }

  heightAt(d: number): number {
    return this.pointAt(d).y;
  }

  /** Heading angle (radians, atan2 of x/z direction) at distance d. */
  headingAt(d: number): number {
    const a = this.pointAt(d - 3);
    const b = this.pointAt(d + 3);
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  /** Smoothed grade in percent at distance d. */
  gradeAt(d: number): number {
    const span = 10;
    return ((this.heightAt(d + span) - this.heightAt(d - span)) / (2 * span)) * 100;
  }

  /** Total climbing on one lap, metres. */
  totalAscent(): number {
    let g = 0;
    for (let i = 0; i < this.count; i++) {
      const dy = this.ys[this.idx(i + 1)] - this.ys[i];
      if (dy > 0) g += dy;
    }
    return g;
  }

  /** Distance of the highest point (for the KOM banner). */
  summitDistance(): number {
    let best = 0;
    for (let i = 1; i < this.count; i++) if (this.ys[i] > this.ys[best]) best = i;
    return best * this.step;
  }
}
