import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, LogEntry, ShowState } from '@rsc/protocol';
import { AgentCore, type CoreTransport } from './core.js';
import { emptyStatus, type Adapter, type AppStatus } from './adapters/types.js';

const SPK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** A pretend PowerPoint: 4 slides, slide 2 has 2 click builds. */
class FakePowerPoint implements Adapter {
  readonly kind = 'powerpoint-win' as const;
  readonly canReadPosition = true;
  readonly canExportDuringShow = true;
  builds = [0, 2, 0, 0];
  slide = 1;
  build = 0;
  inShow = true;
  blank = false;
  calls: string[] = [];
  failNext = false;

  async status(): Promise<AppStatus> {
    const s = emptyStatus(this.kind);
    s.running = true;
    s.open = true;
    s.inShow = this.inShow;
    s.slideCount = 4;
    s.fileName = 'deck.pptx';
    s.slide = this.inShow ? this.slide : null;
    s.build = this.inShow ? this.build : null;
    s.buildCount = this.inShow ? this.builds[this.slide - 1]! : null;
    s.blank = this.blank;
    return s;
  }
  async next() {
    this.calls.push('next');
    if (this.failNext) throw new Error('PowerPoint is busy');
    if (this.build < this.builds[this.slide - 1]!) this.build++;
    else if (this.slide < 4) {
      this.slide++;
      this.build = 0;
    }
  }
  async previous() {
    this.calls.push('previous');
    if (this.build > 0) this.build--;
    else if (this.slide > 1) {
      this.slide--;
      this.build = this.builds[this.slide - 1]!;
    }
  }
  async goto(n: number) {
    this.calls.push(`goto ${n}`);
    this.slide = n;
    this.build = 0;
  }
  async setBlank(on: boolean) {
    this.blank = on;
  }
  async startShow() {
    this.inShow = true;
  }
  async buildCounts() {
    return this.builds;
  }
  async exportDeck() {
    return [];
  }
  dispose() {}
}

function setup() {
  const app = new FakePowerPoint();
  const states: ShowState[] = [];
  const toSpeaker: Array<{ invite: string; event: string; payload: unknown }> = [];
  const toOperator: Array<{ event: string; payload: unknown }> = [];
  const logs: LogEntry[] = [];
  const laser = vi.fn();
  const identities: string[] = [];
  let now = 1_000_000;
  const transport: CoreTransport = {
    broadcastState: (s) => states.push(s),
    broadcastDeck: () => {},
    toSpeaker: (invite, event, payload) => toSpeaker.push({ invite, event, payload }),
    toOperator: (event, payload) => toOperator.push({ event, payload }),
  };
  const core = new AgentCore({
    transport,
    getAdapter: () => app,
    storeLog: (e) => logs.push(e),
    laser,
    speakerName: (id) => (id === SPK ? 'Keynote speaker' : 'Panel host'),
    onDeckIdentity: (id) => identities.push(id.key),
    onResync: () => {},
    onInvitesChanged: () => {},
    now: () => now,
    boot: 'test',
  });
  const results = () => toSpeaker.filter((m) => m.event === 'cmd_result').map((m) => m.payload as CommandResult);
  return { app, core, states, toSpeaker, toOperator, logs, laser, identities, results, advance: (ms: number) => (now += ms) };
}

async function giveControl(core: AgentCore, invite = SPK) {
  await core.onOperatorAction({ id: 'op1', action: { type: 'controller', inviteId: invite } });
}

describe('AgentCore', () => {
  it('reads the deck and position on poll and publishes state', async () => {
    const { core, states, identities } = setup();
    await core.poll();
    const s = states.at(-1)!;
    expect(s.app).toBe('powerpoint-win');
    expect(s.inShow).toBe(true);
    expect(s.pos).toEqual({ slide: 1, build: 0 });
    expect(s.deck?.fileName).toBe('deck.pptx');
    expect(identities).toHaveLength(1);
  });

  it('executes next for the speaker in control and confirms the new position', async () => {
    const { core, app, results } = setup();
    await core.poll();
    await giveControl(core);
    await core.onSpeakerCommand(SPK, { id: 'c1', op: 'next', from: { slide: 1, build: 0 } });
    expect(app.calls).toEqual(['next']);
    expect(results().at(-1)).toMatchObject({ id: 'c1', ok: true, pos: { slide: 2, build: 0 } });
  });

  it('never executes a resent command twice and answers the resend with the original result', async () => {
    const { core, app, results, logs } = setup();
    await core.poll();
    await giveControl(core);
    await core.onSpeakerCommand(SPK, { id: 'c1', op: 'next', from: { slide: 1, build: 0 } });
    await core.onSpeakerCommand(SPK, { id: 'c1', op: 'next', from: { slide: 1, build: 0 } });
    expect(app.calls).toEqual(['next']);
    expect(results()).toHaveLength(2);
    expect(results()[1]).toMatchObject({ id: 'c1', ok: true });
    expect(logs.at(-1)?.kind).toBe('dup');
  });

  it('ignores a double click sent from the old position', async () => {
    const { core, app, results } = setup();
    await core.poll();
    await giveControl(core);
    await core.onSpeakerCommand(SPK, { id: 'a', op: 'next', from: { slide: 1, build: 0 } });
    await core.onSpeakerCommand(SPK, { id: 'b', op: 'next', from: { slide: 1, build: 0 } });
    expect(app.calls).toEqual(['next']);
    expect(results()[1]).toMatchObject({ id: 'b', ok: false, reason: 'stale' });
  });

  it('steps through builds before moving slides', async () => {
    const { core, app } = setup();
    app.slide = 2;
    await core.poll();
    await giveControl(core);
    await core.onSpeakerCommand(SPK, { id: 'a', op: 'next', from: { slide: 2, build: 0 } });
    await core.onSpeakerCommand(SPK, { id: 'b', op: 'next', from: { slide: 2, build: 1 } });
    await core.onSpeakerCommand(SPK, { id: 'c', op: 'next', from: { slide: 2, build: 2 } });
    expect(core.snapshot().pos).toEqual({ slide: 3, build: 0 });
    expect(core.snapshot().deck?.buildCounts[1]).toBe(2);
  });

  it('blocks speakers without control and when locked, but the operator still works', async () => {
    const { core, app, results } = setup();
    await core.poll();
    await giveControl(core);
    await core.onSpeakerCommand(OTHER, { id: 'x', op: 'next', from: { slide: 1, build: 0 } });
    expect(results().at(-1)).toMatchObject({ ok: false, reason: 'no_control' });
    await core.onOperatorAction({ id: 'l', action: { type: 'lock', on: true } });
    await core.onSpeakerCommand(SPK, { id: 'y', op: 'next', from: { slide: 1, build: 0 } });
    expect(results().at(-1)).toMatchObject({ ok: false, reason: 'locked' });
    expect(app.calls).toEqual([]);
    await core.onOperatorAction({ id: 'n', action: { type: 'nav', op: 'next' } });
    expect(app.calls).toEqual(['next']);
  });

  it('reports app errors to the speaker instead of hanging', async () => {
    const { core, app, results, logs } = setup();
    await core.poll();
    await giveControl(core);
    app.failNext = true;
    await core.onSpeakerCommand(SPK, { id: 'e', op: 'next', from: { slide: 1, build: 0 } });
    expect(results().at(-1)).toMatchObject({ ok: false, reason: 'app_error' });
    expect(logs.at(-1)?.kind).toBe('error');
  });

  it('starts the countdown on the first confirmed slide change', async () => {
    const { core, advance } = setup();
    await core.poll();
    await giveControl(core);
    expect(core.snapshot().timer.started).toBe(false);
    await core.onSpeakerCommand(SPK, { id: 'a', op: 'next', from: { slide: 1, build: 0 } });
    expect(core.snapshot().timer.started).toBe(true);
    advance(30_000);
    expect(core.snapshot().timer.elapsedMs).toBe(30_000);
  });

  it('also starts the countdown when the slide is moved on the laptop itself', async () => {
    const { core, app } = setup();
    await core.poll();
    app.slide = 2;
    await core.poll();
    expect(core.snapshot().timer.started).toBe(true);
  });

  it('only draws the laser for the speaker in control', async () => {
    const { core, laser } = setup();
    await core.poll();
    await giveControl(core);
    core.onLaser(SPK, { x: 0.25, y: 0.5 });
    expect(laser).toHaveBeenLastCalledWith({ x: 0.25, y: 0.5 }, expect.anything(), expect.any(Number));
    core.onLaser(OTHER, { x: 0.9, y: 0.9 });
    expect(laser).toHaveBeenLastCalledWith(null, expect.anything(), expect.any(Number));
    core.onLaser(SPK, { x: 5, y: -1 });
    expect(laser).toHaveBeenLastCalledWith({ x: 1, y: 0 }, expect.anything(), expect.any(Number));
  });

  it('answers pings so speakers can measure latency to the laptop', async () => {
    const { core, toSpeaker } = setup();
    core.onPing(SPK, { t: 123 });
    expect(toSpeaker.at(-1)).toEqual({ invite: SPK, event: 'pong', payload: { t: 123 } });
  });

  it('applies timer actions from the operator', async () => {
    const { core } = setup();
    await core.onOperatorAction({ id: 't1', action: { type: 'timer', action: 'length', seconds: 900 } });
    await core.onOperatorAction({ id: 't2', action: { type: 'timer', action: 'start' } });
    const s = core.snapshot();
    expect(s.timer.lengthSec).toBe(900);
    expect(s.timer.running).toBe(true);
  });

  it('reports operator errors back on the op channel', async () => {
    const { core, app, toOperator } = setup();
    app.inShow = false;
    await core.poll();
    await core.onOperatorAction({ id: 'z', action: { type: 'nav', op: 'next' } });
    expect(toOperator.at(-1)).toEqual({ event: 'op_result', payload: { id: 'z', ok: false, error: 'The slideshow is not running' } });
  });

  it('only publishes when something changed', async () => {
    const { core, states, app } = setup();
    await core.poll();
    await core.poll(); // build counts arrive
    const n = states.length;
    await core.poll();
    await core.poll();
    expect(states.length).toBe(n);
    app.slide = 3;
    await core.poll(); // moved on the laptop: publishes (and starts the timer)
    await core.poll();
    await core.poll();
    expect(states.length).toBe(n + 1);
  });
});
