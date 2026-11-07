import { PROTOCOL_VERSION, type ShowState } from './types.js';

export function initialShowState(boot: string): ShowState {
  return {
    v: PROTOCOL_VERSION,
    boot,
    seq: 0,
    app: 'none',
    inShow: false,
    deck: null,
    pos: null,
    posEstimated: false,
    blank: false,
    locked: false,
    controller: null,
    disabled: [],
    timer: { lengthSec: 20 * 60, elapsedMs: 0, running: false, autoStart: true, started: false },
    laser: { color: '#FF4D4D', size: 'M' },
    showControl: { httpPort: null, oscPort: null, lan: false },
  };
}

/** Light structural check for snapshots arriving off the wire. */
export function isShowState(v: unknown): v is ShowState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    s.v === PROTOCOL_VERSION &&
    typeof s.boot === 'string' &&
    typeof s.seq === 'number' &&
    typeof s.app === 'string' &&
    typeof s.inShow === 'boolean' &&
    typeof s.locked === 'boolean' &&
    Array.isArray(s.disabled) &&
    !!s.timer &&
    typeof s.timer === 'object'
  );
}

/**
 * Should a client replace `current` with `next`? A new boot always wins (the
 * agent restarted); within a boot only newer-or-equal seq is accepted, so a
 * heartbeat that crossed a fresher update in flight cannot roll the view back.
 */
export function shouldAccept(current: ShowState | null, next: ShowState): boolean {
  if (!current) return true;
  if (current.boot !== next.boot) return true;
  return next.seq >= current.seq;
}
