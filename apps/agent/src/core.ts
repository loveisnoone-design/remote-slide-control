import {
  EVENTS,
  RecentIds,
  applyTimerAction,
  clamp01,
  createTimer,
  decideSpeakerCommand,
  describeReject,
  formatPosition,
  initialShowState,
  onConfirmedSlideChange,
  snapshotTimer,
  type AppKind,
  type CommandResult,
  type Decision,
  type LaserPoint,
  type LaserStyle,
  type LogEntry,
  type LogKind,
  type OperatorAction,
  type OperatorEnvelope,
  type RejectReason,
  type ShowState,
  type SpeakerCommand,
  type TimerModel,
} from '@rsc/protocol';
import type { Adapter, AppStatus } from './adapters/types.js';

export interface CoreTransport {
  broadcastState(s: ShowState): void;
  broadcastDeck(deckId: string): void;
  toSpeaker(inviteId: string, event: string, payload: unknown): void;
  toOperator(event: string, payload: unknown): void;
}

export interface DeckIdentity {
  key: string;
  app: AppKind;
  fileName: string;
  filePath: string | null;
  slideCount: number;
  aspect: number;
}

export interface CoreDeps {
  transport: CoreTransport;
  getAdapter: () => Adapter | null;
  /** Persist a click-log line (the agent writes it to public.click_log). */
  storeLog: (e: LogEntry) => void;
  /** Draw or hide the laser dot on the output display. */
  laser: (p: { x: number; y: number } | null, style: LaserStyle, aspect: number) => void;
  speakerName: (inviteId: string) => string;
  /** A different file (or slide count) is now open: export slides and notes for it. */
  onDeckIdentity: (id: DeckIdentity) => void;
  onResync: () => void;
  onInvitesChanged: () => void;
  now?: () => number;
  boot?: string;
  showControl?: ShowState['showControl'];
}

const REJECT_KIND: Record<RejectReason, LogKind> = {
  duplicate: 'dup',
  stale: 'dup',
  at_start: 'info',
  at_end: 'info',
  locked: 'blocked',
  no_control: 'blocked',
  disabled: 'blocked',
  no_show: 'blocked',
  out_of_range: 'blocked',
  app_error: 'error',
};

/**
 * Everything the agent decides, independent of Electron and Supabase. The
 * presentation app is only touched from inside `enqueue`, so commands from the
 * operator, speakers, OSC/HTTP and the poll loop never interleave.
 */
export class AgentCore {
  private state: ShowState;
  private timer: TimerModel;
  private readonly recent = new RecentIds(512);
  private readonly results = new Map<string, CommandResult>();
  private queue: Promise<unknown> = Promise.resolve();
  private trackedBlank = false;
  private buildCounts: Array<number | null> = [];
  private identityKey = '';
  private lastPosKey = '';
  private polling = false;
  private appError: string | null = null;

  constructor(private readonly deps: CoreDeps) {
    this.state = { ...initialShowState(deps.boot ?? randomBoot()), showControl: deps.showControl ?? { httpPort: null, oscPort: null, lan: false } };
    this.timer = createTimer(this.state.timer.lengthSec);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  snapshot(): ShowState {
    return { ...this.state, timer: snapshotTimer(this.timer, this.now()) };
  }

  /** Last error talking to the presentation app (for the agent window). */
  lastAppError(): string | null {
    return this.appError;
  }

  private publish(): void {
    this.state = { ...this.state, seq: this.state.seq + 1 };
    this.deps.transport.broadcastState(this.snapshot());
  }

  /** Re-send the current state without changing seq (heartbeat, late joiners). */
  heartbeat(): void {
    this.deps.transport.broadcastState(this.snapshot());
  }

  setShowControl(sc: ShowState['showControl']): void {
    this.state = { ...this.state, showControl: sc };
    this.publish();
  }

  setTalkLength(seconds: number): void {
    this.timer = applyTimerAction(this.timer, { action: 'length', seconds }, this.now());
    this.publish();
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read the app once (called by the poll loop). Skips if a poll is already queued. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.enqueue(() => this.refresh());
    } finally {
      this.polling = false;
    }
  }

  private async refresh(): Promise<AppStatus | null> {
    const adapter = this.deps.getAdapter();
    if (!adapter) {
      this.appError = null;
      this.applyStatus(null, null);
      return null;
    }
    try {
      const st = await adapter.status();
      this.appError = null;
      this.applyStatus(adapter, st);
      return st;
    } catch (e) {
      this.appError = e instanceof Error ? e.message : String(e);
      this.applyStatus(adapter, null);
      return null;
    }
  }

  private applyStatus(adapter: Adapter | null, st: AppStatus | null): void {
    const prev = this.state;
    const next: ShowState = { ...prev };
    next.app = adapter && st?.running ? adapter.kind : adapter?.kind === 'keys' ? 'keys' : 'none';

    if (!adapter || !st || !st.open) {
      next.inShow = false;
      next.pos = null;
      next.blank = false;
      next.posEstimated = false;
      if (!st?.open) {
        next.deck = null;
        this.identityKey = '';
      }
    } else {
      next.inShow = st.inShow;
      next.posEstimated = !adapter.canReadPosition;
      const key = `${adapter.kind}|${st.fileName ?? ''}|${st.slideCount}`;
      if (key !== this.identityKey) {
        this.identityKey = key;
        this.buildCounts = Array.from({ length: st.slideCount }, () => null);
        next.deck = { fileName: st.fileName, slideCount: st.slideCount, buildCounts: this.buildCounts.slice(), aspect: st.aspect, deckId: null };
        if (st.fileName && adapter.kind !== 'keys') {
          this.deps.onDeckIdentity({ key, app: adapter.kind, fileName: st.fileName, filePath: st.filePath, slideCount: st.slideCount, aspect: st.aspect });
        }
        void this.loadBuildCounts(adapter, key);
      } else if (next.deck && next.deck.aspect !== st.aspect) {
        next.deck = { ...next.deck, aspect: st.aspect };
      }
      if (st.inShow && st.slide && st.buildCount !== null && next.deck && this.buildCounts[st.slide - 1] !== st.buildCount) {
        this.buildCounts[st.slide - 1] = st.buildCount;
        next.deck = { ...next.deck, buildCounts: this.buildCounts.slice() };
      }
      next.pos = st.inShow && st.slide ? { slide: st.slide, build: st.build } : null;
      next.blank = st.inShow ? (st.blank ?? this.trackedBlank) : false;
    }

    const posKey = next.pos ? `${next.pos.slide}:${next.pos.build}` : '';
    if (next.inShow && next.pos && this.lastPosKey && posKey !== this.lastPosKey) {
      // The show actually moved: this is the "first click" for the countdown.
      this.timer = onConfirmedSlideChange(this.timer, this.now());
      const slideChanged = next.pos.slide !== prev.pos?.slide;
      if (slideChanged && st?.blank === null) {
        this.trackedBlank = false;
        next.blank = false;
      }
    }
    this.lastPosKey = posKey;

    // A timer that just auto-started always comes with a position change, so the key covers it.
    const changed = stateKey(prev) !== stateKey(next);
    this.state = next;
    if (changed) this.publish();
  }

  private async loadBuildCounts(adapter: Adapter, key: string): Promise<void> {
    try {
      const counts = await this.enqueue(() => adapter.buildCounts());
      if (key !== this.identityKey || !this.state.deck) return;
      let changed = false;
      counts.forEach((c, i) => {
        if (i < this.buildCounts.length && this.buildCounts[i] === null && c !== null) {
          this.buildCounts[i] = c;
          changed = true;
        }
      });
      if (changed) {
        this.state = { ...this.state, deck: { ...this.state.deck, buildCounts: this.buildCounts.slice() } };
        this.publish();
      }
    } catch {
      // Build counts are a hint; the live click count still arrives on each poll.
    }
  }

  /** The exported deck for the current file is ready (or was found in the database). */
  setDeckId(identityKey: string, deckId: string): void {
    if (identityKey !== this.identityKey || !this.state.deck) return;
    this.state = { ...this.state, deck: { ...this.state.deck, deckId } };
    this.publish();
    this.deps.transport.broadcastDeck(deckId);
  }

  currentIdentityKey(): string {
    return this.identityKey;
  }

  // -------------------------------------------------------------------------
  // Speakers
  // -------------------------------------------------------------------------

  onSpeakerCommand(inviteId: string, raw: unknown): Promise<void> | void {
    const cmd = raw as SpeakerCommand;
    if (!cmd || typeof cmd.id !== 'string' || cmd.id.length > 100) return;
    const name = this.deps.speakerName(inviteId);
    const label = describeCommand(cmd);
    if (this.recent.has(cmd.id)) {
      // A resend: answer with the original result so the sender stops waiting.
      const prior = this.results.get(cmd.id);
      this.deps.transport.toSpeaker(inviteId, EVENTS.speaker.result, prior ?? { id: cmd.id, ok: false, reason: 'duplicate' });
      this.log(name, label, describeReject('duplicate'), 'dup');
      return;
    }
    this.recent.add(cmd.id);
    return this.enqueue(async () => {
      await this.refresh();
      const decision = decideSpeakerCommand(this.state, inviteId, cmd, new RecentIds(1));
      let result: CommandResult;
      if (decision.kind === 'reject') {
        result = { id: cmd.id, ok: false, reason: decision.reason, pos: this.state.pos };
        this.log(name, label, describeReject(decision.reason), REJECT_KIND[decision.reason]);
      } else {
        try {
          await this.execute(decision);
          result = { id: cmd.id, ok: true, pos: this.state.pos };
          this.log(name, label, `ok → ${formatPosition(this.state.pos)}`, 'ok');
        } catch (e) {
          result = { id: cmd.id, ok: false, reason: 'app_error', pos: this.state.pos };
          this.log(name, label, `error · ${errMsg(e)}`, 'error');
        }
      }
      this.remember(cmd.id, result);
      this.deps.transport.toSpeaker(inviteId, EVENTS.speaker.result, result);
    });
  }

  onLaser(inviteId: string, raw: unknown): void {
    const p = raw as LaserPoint;
    const s = this.state;
    const aspect = s.deck?.aspect || 16 / 9;
    const allowed = s.controller === inviteId && !s.locked && !s.disabled.includes(inviteId) && s.inShow && !s.blank;
    if (!allowed || !p || typeof p.x !== 'number' || typeof p.y !== 'number') {
      this.deps.laser(null, s.laser, aspect);
      return;
    }
    this.deps.laser({ x: clamp01(p.x), y: clamp01(p.y) }, s.laser, aspect);
  }

  onPing(inviteId: string, raw: unknown): void {
    const t = (raw as { t?: unknown })?.t;
    if (typeof t === 'number') this.deps.transport.toSpeaker(inviteId, EVENTS.speaker.pong, { t });
  }

  // -------------------------------------------------------------------------
  // Operator (console, OSC, HTTP)
  // -------------------------------------------------------------------------

  onOperatorAction(raw: unknown, source = 'Operator'): Promise<void> {
    const env = raw as OperatorEnvelope;
    const a = env?.action;
    if (!a || typeof a !== 'object') return Promise.resolve();
    return this.enqueue(async () => {
      let ok = true;
      let error: string | undefined;
      try {
        await this.applyOperator(a, source);
      } catch (e) {
        ok = false;
        error = errMsg(e);
      }
      if (env.id) this.deps.transport.toOperator(EVENTS.op.result, { id: env.id, ok, error });
    });
  }

  private async applyOperator(a: OperatorAction, source: string): Promise<void> {
    switch (a.type) {
      case 'nav': {
        await this.refresh();
        if (!this.state.inShow || !this.state.pos) throw new Error('The slideshow is not running');
        const before = formatPosition(this.state.pos);
        const label = a.op === 'goto' ? `goto ${a.slide}` : `${a.op} from ${before}`;
        try {
          if (a.op === 'goto') {
            const n = Number(a.slide);
            const count = this.state.deck?.slideCount ?? 0;
            if (!Number.isInteger(n) || n < 1 || (count > 0 && n > count)) throw new Error('No such slide');
            await this.execute({ kind: 'execute', op: 'goto', slide: n });
          } else {
            await this.execute({ kind: 'execute', op: a.op === 'next' ? 'next' : 'back' });
          }
          this.log(source, label, `ok → ${formatPosition(this.state.pos)}`, 'ok');
        } catch (e) {
          this.log(source, label, `error · ${errMsg(e)}`, 'error');
          throw e;
        }
        return;
      }
      case 'blank': {
        await this.refresh();
        if (!this.state.inShow) throw new Error('The slideshow is not running');
        await this.execute({ kind: 'execute', op: 'blank', on: Boolean(a.on) });
        this.log(source, a.on ? 'blank screen' : 'unblank screen', 'ok', 'ok');
        return;
      }
      case 'start_show': {
        const adapter = this.requireAdapter();
        await adapter.startShow(a.slide);
        await this.settle();
        this.log(source, 'start slideshow', this.state.inShow ? `ok → ${formatPosition(this.state.pos)}` : 'sent', 'ok');
        return;
      }
      case 'lock':
        this.state = { ...this.state, locked: Boolean(a.on) };
        if (a.on) this.deps.laser(null, this.state.laser, this.state.deck?.aspect || 16 / 9);
        this.publish();
        this.log(source, a.on ? 'lock remote control' : 'unlock remote control', 'ok', 'info');
        return;
      case 'controller': {
        const id = typeof a.inviteId === 'string' ? a.inviteId : null;
        this.state = { ...this.state, controller: id };
        this.deps.laser(null, this.state.laser, this.state.deck?.aspect || 16 / 9);
        this.publish();
        this.log(source, `control → ${id ? this.deps.speakerName(id) : 'operator only'}`, 'ok', 'info');
        return;
      }
      case 'enable': {
        const set = new Set(this.state.disabled);
        if (a.on) set.delete(a.inviteId);
        else set.add(a.inviteId);
        this.state = { ...this.state, disabled: [...set] };
        this.publish();
        this.log(source, `${a.on ? 'enable' : 'disable'} ${this.deps.speakerName(a.inviteId)}`, 'ok', 'info');
        return;
      }
      case 'timer': {
        const { type: _t, ...action } = a;
        this.timer = applyTimerAction(this.timer, action, this.now());
        this.publish();
        if (action.action === 'start' || action.action === 'pause' || action.action === 'reset') {
          this.log(source, `timer ${action.action}`, 'ok', 'info');
        }
        return;
      }
      case 'laser_style': {
        const color = typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : this.state.laser.color;
        const size = a.size === 'S' || a.size === 'M' || a.size === 'L' ? a.size : this.state.laser.size;
        this.state = { ...this.state, laser: { color, size } };
        this.publish();
        return;
      }
      case 'resync':
        this.identityKey = '';
        await this.refresh();
        this.deps.onResync();
        return;
      case 'invites_changed':
        this.deps.onInvitesChanged();
        return;
    }
  }

  // -------------------------------------------------------------------------

  private requireAdapter(): Adapter {
    const adapter = this.deps.getAdapter();
    if (!adapter) throw new Error('No presentation app detected');
    return adapter;
  }

  /** Run a decided action against the app and read the result back. Must run inside enqueue. */
  private async execute(d: Exclude<Decision, { kind: 'reject' }>): Promise<void> {
    const adapter = this.requireAdapter();
    const before = this.state.pos ? `${this.state.pos.slide}:${this.state.pos.build}` : '';
    switch (d.op) {
      case 'next':
        await adapter.next();
        break;
      case 'back':
        await adapter.previous();
        break;
      case 'goto':
        await adapter.goto(d.slide);
        break;
      case 'blank': {
        await adapter.setBlank(d.on);
        this.trackedBlank = d.on;
        break;
      }
    }
    await this.refresh();
    const after = this.state.pos ? `${this.state.pos.slide}:${this.state.pos.build}` : '';
    if (d.op !== 'blank' && after === before) {
      // Some apps update their reported position a moment after the transition starts.
      await this.settle();
    }
  }

  private async settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 150));
    await this.refresh();
  }

  private remember(id: string, r: CommandResult): void {
    this.results.set(id, r);
    if (this.results.size > 512) {
      const first = this.results.keys().next().value;
      if (first !== undefined) this.results.delete(first);
    }
  }

  log(source: string, command: string, result: string, kind: LogKind): void {
    const e: LogEntry = { at: new Date(this.now()).toISOString(), source: source.slice(0, 80), command: command.slice(0, 200), result: result.slice(0, 200), kind };
    this.deps.transport.toOperator(EVENTS.op.log, e);
    this.deps.storeLog(e);
  }
}

function describeCommand(cmd: SpeakerCommand): string {
  switch (cmd.op) {
    case 'next':
    case 'back':
      return `${cmd.op} from ${formatPosition(cmd.from ?? null)}`;
    case 'goto':
      return `goto ${cmd.slide}`;
    case 'blank':
      return cmd.on === false ? 'unblank screen' : 'blank screen';
    default:
      return String((cmd as { op?: unknown }).op ?? 'unknown');
  }
}

/** Fields that matter to clients (seq and live timer excluded). */
function stateKey(s: ShowState): string {
  return JSON.stringify([s.app, s.inShow, s.deck, s.pos, s.posEstimated, s.blank, s.locked, s.controller, s.disabled, s.laser, s.showControl]);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function randomBoot(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
