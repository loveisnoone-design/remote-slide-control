import { fitRect, laserDiameter, smoothStep, toOutputPixels, type LaserSize } from '@rsc/protocol';

/**
 * Draws the laser dot on a transparent, click-through window that covers the
 * output display. Network updates arrive ~15×/s; this draws at display refresh
 * and eases toward the latest point so motion looks continuous.
 */

interface LaserMsg {
  hide?: boolean;
  x?: number;
  y?: number;
  color?: string;
  size?: LaserSize;
  aspect?: number;
}

declare global {
  interface Window {
    rscOverlay: { onLaser: (cb: (m: LaserMsg) => void) => void };
  }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

let target: { x: number; y: number } | null = null;
let cur: { x: number; y: number } | null = null;
let alpha = 0;
let color = '#FF4D4D';
let size: LaserSize = 'M';
let aspect = 16 / 9;
let last = performance.now();

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

window.rscOverlay.onLaser((m) => {
  if (m.hide) {
    target = null;
    return;
  }
  if (typeof m.x !== 'number' || typeof m.y !== 'number') return;
  if (m.color) color = m.color;
  if (m.size) size = m.size;
  if (m.aspect && m.aspect > 0) aspect = m.aspect;
  const slide = fitRect(window.innerWidth, window.innerHeight, aspect);
  const { px, py } = toOutputPixels(m.x, m.y, slide);
  target = { x: px, y: py };
  if (!cur || alpha < 0.05) cur = { ...target }; // appear where the finger is, don't fly in
});

function frame(now: number) {
  const dt = Math.min(100, now - last);
  last = now;
  alpha = smoothStep(alpha, target ? 1 : 0, dt, target ? 40 : 90);
  if (target && cur) {
    cur = { x: smoothStep(cur.x, target.x, dt), y: smoothStep(cur.y, target.y, dt) };
  }
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (cur && alpha > 0.02) {
    const d = laserDiameter(size, window.innerHeight);
    ctx.globalAlpha = alpha * 0.28;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, d * 0.95, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, d / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, d * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
