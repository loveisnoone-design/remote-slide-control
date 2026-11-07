import type { Position, RejectReason, ShowState, SpeakerCommand } from './types.js';

/** Remembers recent command ids so a resent command is never executed twice. */
export class RecentIds {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  constructor(private readonly max = 512) {}

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    while (this.order.length > this.max) {
      const old = this.order.shift();
      if (old !== undefined) this.set.delete(old);
    }
  }
}

export type Decision =
  | { kind: 'execute'; op: 'next' | 'back' }
  | { kind: 'execute'; op: 'goto'; slide: number }
  | { kind: 'execute'; op: 'blank'; on: boolean }
  | { kind: 'reject'; reason: RejectReason };

export function samePosition(a: Position, b: Position): boolean {
  if (a.slide !== b.slide) return false;
  // When either side cannot see builds, compare slides only.
  if (a.build === null || b.build === null) return true;
  return a.build === b.build;
}

export function isAtStart(state: ShowState): boolean {
  const pos = state.pos;
  if (!pos) return false;
  return pos.slide <= 1 && (pos.build === null || pos.build <= 0);
}

export function isAtEnd(state: ShowState): boolean {
  const pos = state.pos;
  const deck = state.deck;
  if (!pos || !deck || deck.slideCount <= 0) return false;
  if (pos.slide < deck.slideCount) return false;
  const builds = deck.buildCounts[pos.slide - 1];
  if (pos.build === null || builds === null || builds === undefined) return true;
  return pos.build >= builds;
}

/**
 * Decide what to do with a command from a speaker. Pure: the agent calls this,
 * executes the result against the presentation app and then records the id.
 *
 * Order matters: duplicates are reported first (so a resend after success is
 * quietly ignored), then permission, then position checks.
 */
export function decideSpeakerCommand(
  state: ShowState,
  senderInviteId: string,
  cmd: SpeakerCommand,
  recent: RecentIds,
): Decision {
  if (!cmd || typeof cmd.id !== 'string' || cmd.id.length === 0) return { kind: 'reject', reason: 'stale' };
  if (recent.has(cmd.id)) return { kind: 'reject', reason: 'duplicate' };
  if (state.disabled.includes(senderInviteId)) return { kind: 'reject', reason: 'disabled' };
  if (state.locked) return { kind: 'reject', reason: 'locked' };
  if (state.controller !== senderInviteId) return { kind: 'reject', reason: 'no_control' };
  if (!state.inShow || !state.pos) return { kind: 'reject', reason: 'no_show' };

  switch (cmd.op) {
    case 'next':
    case 'back': {
      if (!cmd.from || !isPosition(cmd.from)) return { kind: 'reject', reason: 'stale' };
      if (!samePosition(cmd.from, state.pos)) return { kind: 'reject', reason: 'stale' };
      if (cmd.op === 'next' && isAtEnd(state)) return { kind: 'reject', reason: 'at_end' };
      if (cmd.op === 'back' && isAtStart(state)) return { kind: 'reject', reason: 'at_start' };
      return { kind: 'execute', op: cmd.op };
    }
    case 'goto': {
      const n = cmd.slide;
      const count = state.deck?.slideCount ?? 0;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || (count > 0 && n > count)) {
        return { kind: 'reject', reason: 'out_of_range' };
      }
      return { kind: 'execute', op: 'goto', slide: n };
    }
    case 'blank':
      return { kind: 'execute', op: 'blank', on: cmd.on ?? !state.blank };
    default:
      return { kind: 'reject', reason: 'stale' };
  }
}

export function isPosition(p: unknown): p is Position {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.slide === 'number' &&
    Number.isInteger(o.slide) &&
    (o.build === null || (typeof o.build === 'number' && Number.isInteger(o.build)))
  );
}

/** Short human text for the click log and the speaker UI. */
export function describeReject(reason: RejectReason): string {
  switch (reason) {
    case 'duplicate':
      return 'ignored · duplicate';
    case 'stale':
      return 'ignored · slide already moved';
    case 'locked':
      return 'blocked · remote control locked';
    case 'no_control':
      return 'blocked · no control';
    case 'disabled':
      return 'blocked · speaker disabled';
    case 'no_show':
      return 'blocked · slideshow not running';
    case 'at_start':
      return 'ignored · first slide';
    case 'at_end':
      return 'ignored · last slide';
    case 'out_of_range':
      return 'blocked · no such slide';
    case 'app_error':
      return 'error · presentation app did not respond';
  }
}

/** "3·1" for slide 3 build 1, "3" when builds are unknown. */
export function formatPosition(p: Position | null | undefined): string {
  if (!p) return '–';
  return p.build === null ? String(p.slide) : `${p.slide}·${p.build}`;
}
