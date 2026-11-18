import type { Route } from '../world/route';
import type { Game } from '../game';
import { Workout, workoutDuration } from '../workouts';
import type { Units } from '../settings';

export const fmtTime = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

export const fmtDist = (m: number, u: Units) => (u === 'metric' ? (m / 1000).toFixed(2) : (m / 1609.344).toFixed(2));
export const fmtSpeed = (ms: number, u: Units) => (u === 'metric' ? ms * 3.6 : ms * 2.23694).toFixed(1);

/** Minimap: route drawn once into an offscreen canvas, then dots per frame. */
export class Minimap {
  private bg: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private cx = 0;
  private cz = 0;

  constructor(private canvas: HTMLCanvasElement, private route: Route) {
    this.ctx = canvas.getContext('2d')!;
    this.bg = document.createElement('canvas');
    this.bg.width = canvas.width;
    this.bg.height = canvas.height;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < route.count; i++) {
      minX = Math.min(minX, route.xs[i]); maxX = Math.max(maxX, route.xs[i]);
      minZ = Math.min(minZ, route.zs[i]); maxZ = Math.max(maxZ, route.zs[i]);
    }
    this.cx = (minX + maxX) / 2;
    this.cz = (minZ + maxZ) / 2;
    this.scale = (canvas.width * 0.8) / Math.max(maxX - minX, maxZ - minZ);
    const g = this.bg.getContext('2d')!;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3;
    g.beginPath();
    for (let i = 0; i < route.count; i += 8) {
      const [x, y] = this.map(route.xs[i], route.zs[i]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.stroke();
  }

  private map(x: number, z: number): [number, number] {
    // Top-down view: world +x to the right, world +z downwards.
    return [this.canvas.width / 2 + (x - this.cx) * this.scale, this.canvas.height / 2 + (z - this.cz) * this.scale];
  }

  draw(game: Game) {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.bg, 0, 0);
    const p = { x: 0, y: 0, z: 0 };
    for (const b of game.bots) {
      this.route.pointAt(b.distance, p);
      const [x, y] = this.map(p.x, p.z);
      c.fillStyle = '#9fb3c8';
      c.beginPath();
      c.arc(x, y, 4, 0, Math.PI * 2);
      c.fill();
    }
    this.route.pointAt(game.player.distance, p);
    const [x, y] = this.map(p.x, p.z);
    c.fillStyle = '#ff6a2b';
    c.strokeStyle = '#000';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 6, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
}

/** Elevation profile of the lap with the rider's position. */
export class Profile {
  private bg: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement, private route: Route) {
    this.ctx = canvas.getContext('2d')!;
    this.bg = document.createElement('canvas');
    this.bg.width = canvas.width;
    this.bg.height = canvas.height;
    const g = this.bg.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const range = Math.max(20, route.maxY - route.minY);
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x++) {
      const d = (x / W) * route.length;
      const y = H - 6 - ((route.heightAt(d) - route.minY) / range) * (H - 14);
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,140,60,0.9)');
    grad.addColorStop(1, 'rgba(255,140,60,0.15)');
    g.fillStyle = grad;
    g.fill();
  }

  draw(distance: number, label: string) {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.drawImage(this.bg, 0, 0);
    const x = (this.route.wrap(distance) / this.route.length) * W;
    c.fillStyle = '#fff';
    c.fillRect(x - 1.5, 0, 3, H);
    c.font = 'bold 20px system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.textAlign = x > W - 200 ? 'right' : 'left';
    c.fillText(label, x + (x > W - 200 ? -8 : 8), 22);
  }
}

/** Workout block chart with progress cursor. */
export function drawWorkoutChart(canvas: HTMLCanvasElement, w: Workout, ftp: number, t: number) {
  const c = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const total = workoutDuration(w);
  c.clearRect(0, 0, W, H);
  if (!total) return;
  const toW = (f: number) => (f < 0 ? -f : f * ftp);
  const maxW = Math.max(...w.intervals.map((i) => Math.max(toW(i.from), toW(i.to ?? i.from)))) * 1.1;
  let acc = 0;
  for (const iv of w.intervals) {
    const x0 = (acc / total) * W;
    const x1 = ((acc + iv.seconds) / total) * W;
    const a = toW(iv.from);
    const b = toW(iv.to ?? iv.from);
    const mid = (a + b) / 2 / ftp;
    c.fillStyle = mid < 0.6 ? '#7a8794' : mid < 0.76 ? '#2b8cff' : mid < 0.9 ? '#3ccf7a' : mid < 1.05 ? '#ffcf3a' : mid < 1.2 ? '#ff8a2b' : '#ff4d5a';
    c.beginPath();
    c.moveTo(x0, H);
    c.lineTo(x0, H - (a / maxW) * H);
    c.lineTo(x1, H - (b / maxW) * H);
    c.lineTo(x1, H);
    c.closePath();
    c.fill();
    acc += iv.seconds;
  }
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fillRect(0, 0, (t / total) * W, H);
  c.fillStyle = '#fff';
  c.fillRect((t / total) * W - 1, 0, 2, H);
}
