import { describe, expect, it } from 'vitest';
import {
  applyTimerAction,
  countdownView,
  createTimer,
  elapsedFromSnapshot,
  formatClock,
  onConfirmedSlideChange,
  snapshotTimer,
  timerElapsedMs,
} from './timer.js';

describe('timer model', () => {
  it('waits until the first confirmed slide change', () => {
    let t = createTimer(1200);
    expect(snapshotTimer(t, 0).running).toBe(false);
    t = onConfirmedSlideChange(t, 1000);
    expect(t.started).toBe(true);
    expect(timerElapsedMs(t, 6000)).toBe(5000);
    // A second slide change does not restart it.
    const again = onConfirmedSlideChange(t, 9000);
    expect(again).toBe(t);
  });

  it('does not auto start when auto start is off', () => {
    let t = applyTimerAction(createTimer(), { action: 'autostart', on: false }, 0);
    t = onConfirmedSlideChange(t, 100);
    expect(t.started).toBe(false);
  });

  it('pauses, resumes and resets', () => {
    let t = applyTimerAction(createTimer(600), { action: 'start' }, 0);
    t = applyTimerAction(t, { action: 'pause' }, 10_000);
    expect(timerElapsedMs(t, 50_000)).toBe(10_000);
    t = applyTimerAction(t, { action: 'start' }, 60_000);
    expect(timerElapsedMs(t, 65_000)).toBe(15_000);
    t = applyTimerAction(t, { action: 'reset' }, 70_000);
    expect(timerElapsedMs(t, 80_000)).toBe(0);
    expect(t.started).toBe(false);
  });

  it('adjusts length but never below one minute', () => {
    let t = applyTimerAction(createTimer(600), { action: 'adjust', seconds: 60 }, 0);
    expect(t.lengthSec).toBe(660);
    t = applyTimerAction(t, { action: 'length', seconds: 10 }, 0);
    expect(t.lengthSec).toBe(60);
    t = applyTimerAction(t, { action: 'adjust', seconds: -120 }, 0);
    expect(t.lengthSec).toBe(60);
  });

  it('lets clients extrapolate from a snapshot using their own clock', () => {
    const snap = { lengthSec: 600, elapsedMs: 30_000, running: true, autoStart: true, started: true };
    expect(elapsedFromSnapshot(snap, 1_000, 3_500)).toBe(32_500);
    expect(elapsedFromSnapshot({ ...snap, running: false }, 1_000, 3_500)).toBe(30_000);
  });
});

describe('countdownView', () => {
  it('shows the full length while waiting', () => {
    const v = countdownView(1200, 0, false);
    expect(v.phase).toBe('waiting');
    expect(v.text).toBe('20:00');
  });

  it('moves through warning, final and over time', () => {
    expect(countdownView(1200, 600_000, true).phase).toBe('normal');
    expect(countdownView(1200, (1200 - 300) * 1000, true).phase).toBe('warning');
    expect(countdownView(1200, (1200 - 60) * 1000, true).phase).toBe('final');
    const over = countdownView(1200, (1200 + 42) * 1000, true);
    expect(over.phase).toBe('over');
    expect(over.text).toBe('+00:42');
  });

  it('only shows 00:00 when time is really up', () => {
    expect(countdownView(60, 59_500, true).text).toBe('00:01');
    expect(countdownView(60, 60_000, true).text).toBe('00:00');
  });

  it('formats hours', () => {
    expect(formatClock(3725)).toBe('1:02:05');
  });
});
