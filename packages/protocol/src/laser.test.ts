import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaserThrottle, fitRect, laserDiameter, smoothStep, toOutputPixels } from './laser.js';
import { parseTopic, topics } from './topics.js';
import { initialShowState, shouldAccept } from './state.js';

describe('fitRect', () => {
  it('pillarboxes a 4:3 deck on a 16:9 output', () => {
    const r = fitRect(1920, 1080, 4 / 3);
    expect(r).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
  });

  it('letterboxes a 16:9 deck on a 16:10 output', () => {
    const r = fitRect(1920, 1200, 16 / 9);
    expect(r.w).toBe(1920);
    expect(r.h).toBe(1080);
    expect(r.y).toBe(60);
  });

  it('maps normalised points into the slide area', () => {
    const r = fitRect(1920, 1080, 4 / 3);
    expect(toOutputPixels(0, 0, r)).toEqual({ px: 240, py: 0 });
    expect(toOutputPixels(1, 1, r)).toEqual({ px: 1680, py: 1080 });
    expect(toOutputPixels(2, -1, r)).toEqual({ px: 1680, py: 0 });
  });
});

describe('laserDiameter', () => {
  it('scales with output height', () => {
    expect(laserDiameter('M', 1080)).toBe(24);
    expect(laserDiameter('M', 2160)).toBe(48);
  });
});

describe('LaserThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the first point, limits the rate and flushes the last point', () => {
    vi.useFakeTimers();
    let now = 0;
    const sent: Array<{ x: number | null; y: number | null }> = [];
    const t = new LaserThrottle((p) => sent.push(p), 10, () => now);
    t.push(0.1, 0.1);
    now = 20;
    t.push(0.2, 0.2);
    now = 40;
    t.push(0.3, 0.3);
    expect(sent).toEqual([{ x: 0.1, y: 0.1 }]);
    now = 100;
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.3 },
    ]);
  });

  it('sends hide immediately', () => {
    let now = 0;
    const sent: Array<{ x: number | null; y: number | null }> = [];
    const t = new LaserThrottle((p) => sent.push(p), 10, () => now);
    t.push(0.5, 0.5);
    now = 5;
    t.push(null, null);
    expect(sent).toEqual([
      { x: 0.5, y: 0.5 },
      { x: null, y: null },
    ]);
  });
});

describe('smoothStep', () => {
  it('approaches the target without overshooting', () => {
    const v = smoothStep(0, 1, 16);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    expect(smoothStep(0, 1, 10_000)).toBeCloseTo(1, 5);
  });
});

describe('topics', () => {
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const inv = '11111111-1111-4111-8111-111111111111';

  it('round-trips topic names', () => {
    expect(parseTopic(topics.state(sid))).toEqual({ kind: 'state', sessionId: sid });
    expect(parseTopic(topics.op(sid))).toEqual({ kind: 'op', sessionId: sid });
    expect(parseTopic(topics.speaker(sid, inv))).toEqual({ kind: 'speaker', sessionId: sid, inviteId: inv });
  });

  it('rejects anything else', () => {
    expect(parseTopic(`rsc:${sid}:other`)).toBeNull();
    expect(parseTopic(`rsc:not-a-uuid:state`)).toBeNull();
    expect(parseTopic(`${topics.state(sid)}:x`)).toBeNull();
  });
});

describe('shouldAccept', () => {
  it('keeps newer snapshots and accepts a new agent boot', () => {
    const a = { ...initialShowState('one'), seq: 5 };
    expect(shouldAccept(a, { ...a, seq: 4 })).toBe(false);
    expect(shouldAccept(a, { ...a, seq: 6 })).toBe(true);
    expect(shouldAccept(a, { ...initialShowState('two'), seq: 1 })).toBe(true);
    expect(shouldAccept(null, a)).toBe(true);
  });
});
