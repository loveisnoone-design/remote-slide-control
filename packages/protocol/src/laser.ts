import type { LaserSize } from './types.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a slide of the given aspect ratio sits inside a container, letterboxed
 * the way PowerPoint and Keynote do on an output of a different shape
 * (a 4:3 deck on a 16:9 screen gets bars left and right).
 */
export function fitRect(containerW: number, containerH: number, aspect: number): Rect {
  if (!(containerW > 0) || !(containerH > 0) || !(aspect > 0)) return { x: 0, y: 0, w: containerW, h: containerH };
  const containerAspect = containerW / containerH;
  if (containerAspect > aspect) {
    const h = containerH;
    const w = h * aspect;
    return { x: (containerW - w) / 2, y: 0, w, h };
  }
  const w = containerW;
  const h = w / aspect;
  return { x: 0, y: (containerH - h) / 2, w, h };
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Normalised slide coordinates → pixel position on the output. */
export function toOutputPixels(x: number, y: number, slide: Rect): { px: number; py: number } {
  return { px: slide.x + clamp01(x) * slide.w, py: slide.y + clamp01(y) * slide.h };
}

/** Dot diameter in px for an output of the given height (sizes tuned on 1080p). */
export function laserDiameter(size: LaserSize, outputHeight: number): number {
  const base = size === 'S' ? 16 : size === 'L' ? 34 : 24;
  return Math.round((base * outputHeight) / 1080);
}

/**
 * Rate-limits laser updates. The first point goes out immediately; while the
 * pointer keeps moving at most one point per interval is sent, and the latest
 * point is always flushed so the dot ends where the finger stopped.
 */
export class LaserThrottle {
  private lastSent = -Infinity;
  private pending: { x: number | null; y: number | null } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (p: { x: number | null; y: number | null }) => void,
    private readonly hz = 15,
    private readonly now: () => number = () => Date.now(),
  ) {}

  push(x: number | null, y: number | null): void {
    const point = x === null || y === null ? { x: null, y: null } : { x: round4(clamp01(x)), y: round4(clamp01(y)) };
    const interval = 1000 / this.hz;
    const t = this.now();
    if (point.x === null || t - this.lastSent >= interval) {
      this.flushTimer();
      this.pending = null;
      this.lastSent = t;
      this.send(point);
      return;
    }
    this.pending = point;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          this.lastSent = this.now();
          this.send(p);
        }
      }, Math.max(0, interval - (t - this.lastSent)));
    }
  }

  dispose(): void {
    this.flushTimer();
    this.pending = null;
  }

  private flushTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Smooths the dot between network updates (updates arrive ~15×/s; the overlay
 * draws at 60 fps). Exponential approach with a time constant, so motion feels
 * continuous without lagging far behind the speaker's finger.
 */
export function smoothStep(current: number, target: number, dtMs: number, timeConstantMs = 45): number {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / timeConstantMs);
  return current + (target - current) * k;
}
