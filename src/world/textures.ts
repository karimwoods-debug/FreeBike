import * as THREE from 'three';
import { mulberry32 } from './route';

/**
 * Tiny procedurally painted textures (64x64 / 128x32). Low resolution +
 * mipmapped linear filtering is the classic PS2-era look and keeps GPU
 * memory use negligible.
 */
function canvasTex(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  paint(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 1;
  return tex;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, base: number[], spread: number, n: number) {
  const rnd = mulberry32(seed);
  ctx.fillStyle = `rgb(${base.join(',')})`;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const k = (rnd() - 0.5) * spread;
    ctx.fillStyle = `rgb(${base.map((c) => Math.max(0, Math.min(255, Math.round(c + k)))).join(',')})`;
    const s = rnd() < 0.8 ? 1 : 2;
    ctx.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), s, s);
  }
}

export function makeRoadTexture() {
  // u across the road (0..1), v along (one tile = 8 m).
  return canvasTex(64, 64, (ctx) => {
    speckle(ctx, 64, 64, 3, [92, 92, 98], 40, 1600);
    ctx.fillStyle = '#e8e8e0';
    ctx.fillRect(2, 0, 2, 64); // edge lines
    ctx.fillRect(60, 0, 2, 64);
    ctx.fillStyle = '#f2d24b';
    ctx.fillRect(31, 0, 2, 36); // centre dash
  });
}

export function makeGrassTexture() {
  return canvasTex(64, 64, (ctx) => {
    speckle(ctx, 64, 64, 11, [200, 200, 200], 70, 2400);
  });
}

export function makeBarkTexture() {
  return canvasTex(16, 16, (ctx) => speckle(ctx, 16, 16, 5, [110, 78, 52], 50, 120));
}

export function makeBannerTexture(text: string, bg: string, fg: string) {
  return canvasTex(
    256,
    32,
    (ctx) => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 256, 32);
      ctx.fillStyle = fg;
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 17);
    },
    false,
  );
}
