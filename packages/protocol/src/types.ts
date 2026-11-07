/**
 * Wire types shared by the web app (speaker, operator) and the show-laptop agent.
 *
 * The agent is the single source of truth for what is on screen. It broadcasts a
 * full ShowState snapshot on the session's state channel whenever anything changes,
 * plus a heartbeat every few seconds so late joiners catch up.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Which presentation app the agent is driving. */
export type AppKind =
  | 'powerpoint-win'
  | 'powerpoint-mac'
  | 'keynote'
  | 'keys' // keystroke fallback: Google Slides in a browser, PDF viewers, anything with arrow keys
  | 'none';

/**
 * Where the show is. `slide` is 1-based and matches the app's own slide numbering
 * (hidden/skipped slides included). `build` is the number of click animations already
 * played on this slide, or null when the app cannot report it (Keynote, keystroke mode).
 */
export interface Position {
  slide: number;
  build: number | null;
}

export interface DeckInfo {
  /** File name as the presentation app reports it, e.g. "opening-keynote.pptx". */
  fileName: string | null;
  slideCount: number;
  /** Click-triggered builds per slide (index 0 = slide 1); null where unknown. */
  buildCounts: Array<number | null>;
  /** Slide width / height, used to map laser coordinates onto the output. */
  aspect: number;
  /** Row id in public.decks holding the agent's exact slide images and notes, once exported. */
  deckId: string | null;
}

export interface TimerSnapshot {
  lengthSec: number;
  /** Elapsed milliseconds at the moment the snapshot was sent. */
  elapsedMs: number;
  running: boolean;
  /** Start automatically on the first confirmed slide change. */
  autoStart: boolean;
  /** True once the timer has run at all since the last reset. */
  started: boolean;
}

export type LaserSize = 'S' | 'M' | 'L';

export interface LaserStyle {
  color: string;
  size: LaserSize;
}

export interface ShowState {
  v: typeof PROTOCOL_VERSION;
  /** Random id per agent start; seq only compares within one boot. */
  boot: string;
  /** Increments on every change; lets clients drop out-of-order snapshots. */
  seq: number;
  app: AppKind;
  /** A slideshow is running (not just a file open in the editor). */
  inShow: boolean;
  deck: DeckInfo | null;
  pos: Position | null;
  /**
   * True when the agent cannot read the position back from the app (keystroke
   * mode) and is counting clicks instead. Clients must not call it "confirmed".
   */
  posEstimated: boolean;
  blank: boolean;
  /** When true only the operator (and local show control) can move slides. */
  locked: boolean;
  /** Invite id of the speaker allowed to drive slides, or null for operator only. */
  controller: string | null;
  /** Invite ids the operator has disabled. */
  disabled: string[];
  timer: TimerSnapshot;
  laser: LaserStyle;
  /** Local show-control endpoints the agent exposes, for the operator console. */
  showControl: { httpPort: number | null; oscPort: number | null; lan: boolean };
}

// ---------------------------------------------------------------------------
// Speaker → agent (speaker's own channel)
// ---------------------------------------------------------------------------

export type NavOp = 'next' | 'back' | 'goto';

export interface SpeakerCommand {
  /** Random id; the agent ignores repeats so a resend never double-steps. */
  id: string;
  op: NavOp | 'blank';
  /** The position the sender was looking at. Required for next/back. */
  from?: Position;
  /** Target slide for goto (1-based). */
  slide?: number;
  /** Target blank state for blank. */
  on?: boolean;
}

export interface LaserPoint {
  /** Normalised 0–1 within the slide, or null to hide the dot. */
  x: number | null;
  y: number | null;
}

export interface Ping {
  t: number;
}

// ---------------------------------------------------------------------------
// Agent → speaker (speaker's own channel)
// ---------------------------------------------------------------------------

export type RejectReason =
  | 'duplicate'
  | 'stale'
  | 'locked'
  | 'no_control'
  | 'disabled'
  | 'no_show'
  | 'at_start'
  | 'at_end'
  | 'out_of_range'
  | 'app_error';

export interface CommandResult {
  id: string;
  ok: boolean;
  reason?: RejectReason;
  /** Position after the command, as read back from the app. */
  pos?: Position | null;
}

// ---------------------------------------------------------------------------
// Operator → agent (op channel)
// ---------------------------------------------------------------------------

export type TimerAction =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'reset' }
  | { action: 'adjust'; seconds: number }
  | { action: 'length'; seconds: number }
  | { action: 'autostart'; on: boolean };

export type OperatorAction =
  | { type: 'nav'; op: NavOp; slide?: number }
  | { type: 'blank'; on: boolean }
  | { type: 'start_show'; slide?: number }
  | { type: 'lock'; on: boolean }
  | { type: 'controller'; inviteId: string | null }
  | { type: 'enable'; inviteId: string; on: boolean }
  | ({ type: 'timer' } & TimerAction)
  | { type: 'laser_style'; color?: string; size?: LaserSize }
  | { type: 'resync' }
  | { type: 'invites_changed' };

export interface OperatorEnvelope {
  id: string;
  action: OperatorAction;
}

// ---------------------------------------------------------------------------
// Operator → speaker (speaker's own channel)
// ---------------------------------------------------------------------------

export interface HostMessage {
  id: string;
  text: string;
  urgent: boolean;
  /** ISO time the message was created. */
  at: string;
}

export interface HostMessageClear {
  id: string;
}

export interface MessageAck {
  id: string;
}

// ---------------------------------------------------------------------------
// Agent → operator (op channel)
// ---------------------------------------------------------------------------

export type LogKind = 'ok' | 'dup' | 'blocked' | 'info' | 'error';

export interface LogEntry {
  at: string;
  source: string;
  command: string;
  result: string;
  kind: LogKind;
}

/** Broadcast event names, grouped by channel. */
export const EVENTS = {
  state: { state: 'state', deck: 'deck' },
  op: { action: 'action', log: 'log', result: 'op_result' },
  speaker: {
    cmd: 'cmd',
    laser: 'laser',
    ping: 'ping',
    pong: 'pong',
    hello: 'hello',
    result: 'cmd_result',
    hostMsg: 'host_msg',
    hostMsgClear: 'host_msg_clear',
    ack: 'ack_msg',
  },
} as const;
