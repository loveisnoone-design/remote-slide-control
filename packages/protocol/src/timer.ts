import type { TimerAction, TimerSnapshot } from './types.js';

/**
 * The agent owns the countdown. Internally it keeps accumulated time plus the
 * moment it last started; snapshots carry the elapsed time at send, and clients
 * add the time since *they received it* — so client and agent clocks never need
 * to agree (the error is one-way network latency, ~0.1 s).
 */
export interface TimerModel {
  lengthSec: number;
  accumulatedMs: number;
  runningSince: number | null;
  autoStart: boolean;
  started: boolean;
}

export function createTimer(lengthSec = 20 * 60): TimerModel {
  return { lengthSec, accumulatedMs: 0, runningSince: null, autoStart: true, started: false };
}

export function timerElapsedMs(t: TimerModel, now: number): number {
  return t.accumulatedMs + (t.runningSince !== null ? Math.max(0, now - t.runningSince) : 0);
}

export function snapshotTimer(t: TimerModel, now: number): TimerSnapshot {
  return {
    lengthSec: t.lengthSec,
    elapsedMs: timerElapsedMs(t, now),
    running: t.runningSince !== null,
    autoStart: t.autoStart,
    started: t.started,
  };
}

export function applyTimerAction(t: TimerModel, a: TimerAction, now: number): TimerModel {
  switch (a.action) {
    case 'start':
      if (t.runningSince !== null) return t;
      return { ...t, runningSince: now, started: true };
    case 'pause':
      if (t.runningSince === null) return t;
      return { ...t, accumulatedMs: timerElapsedMs(t, now), runningSince: null };
    case 'reset':
      return { ...t, accumulatedMs: 0, runningSince: null, started: false };
    case 'adjust': {
      // "+1 min" gives the speaker more time: lengthen the talk rather than rewind elapsed,
      // so elapsed stays truthful in the log.
      const seconds = Math.trunc(a.seconds);
      return { ...t, lengthSec: Math.max(60, t.lengthSec + seconds) };
    }
    case 'length':
      return { ...t, lengthSec: Math.max(60, Math.min(24 * 3600, Math.trunc(a.seconds))) };
    case 'autostart':
      return { ...t, autoStart: a.on };
  }
}

/** Called by the agent after the first confirmed slide change. */
export function onConfirmedSlideChange(t: TimerModel, now: number): TimerModel {
  if (!t.autoStart || t.started) return t;
  return { ...t, runningSince: now, started: true };
}

/** Client side: elapsed now, given a snapshot and when it arrived (local clock). */
export function elapsedFromSnapshot(s: TimerSnapshot, receivedAt: number, now: number): number {
  return s.elapsedMs + (s.running ? Math.max(0, now - receivedAt) : 0);
}

export type CountdownPhase = 'waiting' | 'normal' | 'warning' | 'final' | 'over';

export const WARNING_AT_SEC = 5 * 60;
export const FINAL_AT_SEC = 60;

export interface CountdownView {
  phase: CountdownPhase;
  /** Whole seconds left; negative when over time. */
  remainingSec: number;
  /** "14:32", or "+00:42" when over time. */
  text: string;
  elapsedText: string;
  label: string;
}

export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function countdownView(lengthSec: number, elapsedMs: number, started: boolean): CountdownView {
  const elapsedSec = Math.floor(elapsedMs / 1000);
  // Ceil the remaining time so "00:00" only shows once time is really up.
  const remainingSec = lengthSec - elapsedMs / 1000;
  const shown = remainingSec >= 0 ? Math.ceil(remainingSec) : -Math.floor(-remainingSec);
  const text = remainingSec >= 0 ? formatClock(shown) : `+${formatClock(-shown)}`;
  const elapsedText = formatClock(elapsedSec);
  if (!started) return { phase: 'waiting', remainingSec: shown, text, elapsedText, label: 'Starts on 1st click' };
  if (remainingSec < 0) return { phase: 'over', remainingSec: shown, text, elapsedText, label: 'Over time' };
  if (remainingSec <= FINAL_AT_SEC) return { phase: 'final', remainingSec: shown, text, elapsedText, label: 'Final minute' };
  if (remainingSec <= WARNING_AT_SEC) return { phase: 'warning', remainingSec: shown, text, elapsedText, label: 'Wrap up soon' };
  return { phase: 'normal', remainingSec: shown, text, elapsedText, label: 'Remaining' };
}
