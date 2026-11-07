import { describe, expect, it } from 'vitest';
import { RecentIds, decideSpeakerCommand, formatPosition, isAtEnd, isAtStart } from './control.js';
import { initialShowState } from './state.js';
import type { ShowState } from './types.js';

const SPK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function live(over: Partial<ShowState> = {}): ShowState {
  return {
    ...initialShowState('boot'),
    app: 'powerpoint-win',
    inShow: true,
    controller: SPK,
    deck: { fileName: 'deck.pptx', slideCount: 6, buildCounts: [0, 0, 3, 0, 0, 0], aspect: 16 / 9, deckId: null },
    pos: { slide: 3, build: 1 },
    ...over,
  };
}

describe('decideSpeakerCommand', () => {
  it('executes next from the position the speaker saw', () => {
    const d = decideSpeakerCommand(live(), SPK, { id: 'a', op: 'next', from: { slide: 3, build: 1 } }, new RecentIds());
    expect(d).toEqual({ kind: 'execute', op: 'next' });
  });

  it('ignores a resent command id', () => {
    const recent = new RecentIds();
    recent.add('a');
    const d = decideSpeakerCommand(live(), SPK, { id: 'a', op: 'next', from: { slide: 3, build: 1 } }, recent);
    expect(d).toEqual({ kind: 'reject', reason: 'duplicate' });
  });

  it('rejects next sent from an older position so a double click cannot skip', () => {
    const d = decideSpeakerCommand(live(), SPK, { id: 'b', op: 'next', from: { slide: 3, build: 0 } }, new RecentIds());
    expect(d).toEqual({ kind: 'reject', reason: 'stale' });
  });

  it('compares slides only when builds are unknown (Keynote)', () => {
    const state = live({ app: 'keynote', pos: { slide: 3, build: null } });
    const d = decideSpeakerCommand(state, SPK, { id: 'c', op: 'next', from: { slide: 3, build: null } }, new RecentIds());
    expect(d).toEqual({ kind: 'execute', op: 'next' });
  });

  it('blocks speakers without control, when locked, and when disabled', () => {
    const cmd = { id: 'd', op: 'next' as const, from: { slide: 3, build: 1 } };
    expect(decideSpeakerCommand(live(), OTHER, cmd, new RecentIds())).toEqual({ kind: 'reject', reason: 'no_control' });
    expect(decideSpeakerCommand(live({ locked: true }), SPK, cmd, new RecentIds())).toEqual({ kind: 'reject', reason: 'locked' });
    expect(decideSpeakerCommand(live({ disabled: [SPK] }), SPK, cmd, new RecentIds())).toEqual({ kind: 'reject', reason: 'disabled' });
    expect(decideSpeakerCommand(live({ controller: null }), SPK, cmd, new RecentIds())).toEqual({ kind: 'reject', reason: 'no_control' });
  });

  it('needs a running slideshow', () => {
    const d = decideSpeakerCommand(live({ inShow: false }), SPK, { id: 'e', op: 'next', from: { slide: 3, build: 1 } }, new RecentIds());
    expect(d).toEqual({ kind: 'reject', reason: 'no_show' });
  });

  it('stops at the ends of the deck', () => {
    const end = live({ pos: { slide: 6, build: 0 } });
    expect(decideSpeakerCommand(end, SPK, { id: 'f', op: 'next', from: { slide: 6, build: 0 } }, new RecentIds())).toEqual({
      kind: 'reject',
      reason: 'at_end',
    });
    const start = live({ pos: { slide: 1, build: 0 } });
    expect(decideSpeakerCommand(start, SPK, { id: 'g', op: 'back', from: { slide: 1, build: 0 } }, new RecentIds())).toEqual({
      kind: 'reject',
      reason: 'at_start',
    });
  });

  it('allows next on the last slide while builds remain', () => {
    const state = live({
      deck: { fileName: 'd', slideCount: 2, buildCounts: [0, 2], aspect: 16 / 9, deckId: null },
      pos: { slide: 2, build: 1 },
    });
    expect(isAtEnd(state)).toBe(false);
    expect(decideSpeakerCommand(state, SPK, { id: 'h', op: 'next', from: { slide: 2, build: 1 } }, new RecentIds())).toEqual({
      kind: 'execute',
      op: 'next',
    });
  });

  it('validates goto targets', () => {
    expect(decideSpeakerCommand(live(), SPK, { id: 'i', op: 'goto', slide: 4 }, new RecentIds())).toEqual({
      kind: 'execute',
      op: 'goto',
      slide: 4,
    });
    expect(decideSpeakerCommand(live(), SPK, { id: 'j', op: 'goto', slide: 7 }, new RecentIds())).toEqual({
      kind: 'reject',
      reason: 'out_of_range',
    });
    expect(decideSpeakerCommand(live(), SPK, { id: 'k', op: 'goto', slide: 0 }, new RecentIds())).toEqual({
      kind: 'reject',
      reason: 'out_of_range',
    });
  });

  it('toggles blank when no target is given', () => {
    expect(decideSpeakerCommand(live({ blank: true }), SPK, { id: 'l', op: 'blank' }, new RecentIds())).toEqual({
      kind: 'execute',
      op: 'blank',
      on: false,
    });
  });

  it('rejects next/back without a from position', () => {
    expect(decideSpeakerCommand(live(), SPK, { id: 'm', op: 'next' }, new RecentIds())).toEqual({ kind: 'reject', reason: 'stale' });
  });
});

describe('RecentIds', () => {
  it('forgets the oldest ids beyond its size', () => {
    const r = new RecentIds(2);
    r.add('a');
    r.add('b');
    r.add('c');
    expect(r.has('a')).toBe(false);
    expect(r.has('b')).toBe(true);
    expect(r.has('c')).toBe(true);
  });
});

describe('position helpers', () => {
  it('formats positions', () => {
    expect(formatPosition({ slide: 3, build: 1 })).toBe('3·1');
    expect(formatPosition({ slide: 3, build: null })).toBe('3');
    expect(formatPosition(null)).toBe('–');
  });

  it('detects the start', () => {
    expect(isAtStart(live({ pos: { slide: 1, build: null } }))).toBe(true);
    expect(isAtStart(live({ pos: { slide: 1, build: 1 } }))).toBe(false);
  });
});
