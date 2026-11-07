import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  EVENTS,
  countdownView,
  elapsedFromSnapshot,
  formatPosition,
  isAtEnd,
  isAtStart,
  topics,
  type LaserPoint,
  type LaserSize,
  type LogEntry,
  type MessageAck,
  type OperatorAction,
  type ShowState,
} from '@rsc/protocol';
import { useAuth } from '../lib/auth';
import { BUCKET, errorText, supabase } from '../lib/supabase';
import { newId, useChannel, useNow, useShowState, type PresenceState } from '../lib/realtime';
import { DECK_COLUMNS, useSlides, type DeckRow } from '../lib/slides';
import { Link } from '../lib/router';
import { Centered, CopyButton, SlideView, Switch, Toast, fmtTime } from '../components/ui';
import { ChevronLeft, ChevronRight, Laptop, Lock } from '../components/Icons';
import { inviteLink } from './Sessions';

interface SessionRow {
  id: string;
  name: string;
  room: string | null;
  talk_length_sec: number;
}

interface InviteRow {
  id: string;
  display_name: string;
  token: string;
  revoked: boolean;
}

interface MessageRow {
  id: string;
  invite_id: string;
  text: string;
  urgent: boolean;
  status: 'delivered' | 'seen' | 'cleared' | 'replaced';
  created_at: string;
  seen_at: string | null;
}

interface Device {
  device: string;
  phone: boolean;
  rtt: number | null;
}

type Sender = (event: string, payload: unknown) => Promise<boolean>;

const APP_LABEL: Record<string, string> = {
  'powerpoint-win': 'PowerPoint (Windows)',
  'powerpoint-mac': 'PowerPoint (Mac)',
  keynote: 'Keynote',
  keys: 'Keystrokes (browser / PDF)',
  none: 'No presentation open',
};
const APP_METHOD: Record<string, string> = {
  'powerpoint-win': 'COM automation',
  'powerpoint-mac': 'AppleScript',
  keynote: 'AppleScript / JXA',
  keys: 'Keystrokes to the front window',
  none: '–',
};

export function OperatorConsole({ sessionId }: { sessionId: string }) {
  const { loading, isOperator } = useAuth();
  const [session, setSession] = useState<SessionRow | null | undefined>(undefined);
  useEffect(() => {
    if (!isOperator) return;
    supabase
      .from('sessions')
      .select('id, name, room, talk_length_sec')
      .eq('id', sessionId)
      .maybeSingle()
      .then(({ data }) => setSession((data as SessionRow | null) ?? null));
  }, [sessionId, isOperator]);

  if (loading) return null;
  if (!isOperator) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Operator sign in needed</h1>
        <Link to="/login" className="btn primary">Sign in</Link>
      </Centered>
    );
  }
  if (session === undefined) return <Centered><p className="muted" style={{ margin: 0 }}>Loading…</p></Centered>;
  if (session === null) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Session not found</h1>
        <Link to="/op" className="btn">Back to sessions</Link>
      </Centered>
    );
  }
  return <ConsoleLive session={session} />;
}

function ConsoleLive({ session }: { session: SessionRow }) {
  const show = useShowState(session.id);
  const st = show.state;
  const now = useNow(500);
  const [toast, setToast] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [presence, setPresence] = useState<Record<string, Device[]>>({});
  const [laser, setLaser] = useState<{ x: number; y: number; at: number } | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const senders = useRef<Record<string, Sender>>({});

  const loadInvites = useCallback(async () => {
    const { data } = await supabase.from('invites').select('id, display_name, token, revoked').eq('session_id', session.id).order('created_at');
    setInvites(((data as InviteRow[]) ?? []).filter((i) => !i.revoked));
  }, [session.id]);

  const loadMessages = useCallback(async () => {
    const { data } = await supabase
      .from('messages')
      .select('id, invite_id, text, urgent, status, created_at, seen_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(6);
    setMessages((data as MessageRow[]) ?? []);
  }, [session.id]);

  useEffect(() => {
    void loadInvites();
    void loadMessages();
    supabase
      .from('click_log')
      .select('at, source, command, result, kind')
      .eq('session_id', session.id)
      .order('at', { ascending: false })
      .limit(30)
      .then(({ data }) => setLog((data as LogEntry[]) ?? []));
  }, [session.id, loadInvites, loadMessages]);

  const op = useChannel({
    topic: topics.op(session.id),
    handlers: {
      [EVENTS.op.log]: (e: LogEntry) => {
        if (e && typeof e.command === 'string') setLog((l) => [e, ...l].slice(0, 50));
      },
      [EVENTS.op.result]: (r: { ok: boolean; error?: string }) => {
        if (r && !r.ok && r.error) setToast(r.error);
      },
    },
  });

  const opSend = useRef(op.send);
  opSend.current = op.send;
  const sendOp = useCallback((action: OperatorAction) => {
    void opSend.current(EVENTS.op.action, { id: newId(), action });
  }, []);

  // Tell the agent when the speaker list changes so it joins the new channels.
  const inviteKey = invites.map((i) => i.id).join(',');
  const firstInviteKey = useRef<string | null>(null);
  useEffect(() => {
    if (op.status !== 'live') return;
    if (firstInviteKey.current === null) {
      // Speakers may have been added on the sessions page since the agent last looked.
      firstInviteKey.current = inviteKey;
      sendOp({ type: 'invites_changed' });
      return;
    }
    if (firstInviteKey.current !== inviteKey) {
      firstInviteKey.current = inviteKey;
      sendOp({ type: 'invites_changed' });
    }
  }, [inviteKey, op.status, sendOp]);

  // Agent starts with the session's talk length.
  const agentNeedsLength = st && !st.timer.started && st.timer.lengthSec !== session.talk_length_sec;
  const lengthSynced = useRef(false);
  useEffect(() => {
    if (agentNeedsLength && !lengthSynced.current && op.status === 'live') {
      lengthSynced.current = true;
      sendOp({ type: 'timer', action: 'length', seconds: session.talk_length_sec });
    }
  }, [agentNeedsLength, op.status, sendOp, session.talk_length_sec]);

  const { slides } = useSlides(st?.deck?.deckId ?? null, show.deckVersion);
  const pos = st?.pos ?? null;
  const cur = pos ? slides.find((s) => s.n === pos.slide) : undefined;
  const aspect = st?.deck?.aspect || 16 / 9;
  const controllerInvite = invites.find((i) => i.id === st?.controller) ?? null;
  const remoteActive = Boolean(st && controllerInvite && !st.locked && !st.disabled.includes(controllerInvite.id));
  const laserVisible = laser && remoteActive && now - laser.at < 2500;
  const buildCount = pos ? st?.deck?.buildCounts[pos.slide - 1] ?? null : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="who">
          <span className="role-tag neutral">Operator</span>
          <div style={{ minWidth: 0 }}>
            <div className="title">
              {session.room ? `${session.room} · ` : ''}
              {session.name}
            </div>
            <div className="sub">
              {st?.deck?.fileName ?? 'No deck open'} · {APP_LABEL[st?.app ?? 'none']} · <Link to="/op">All sessions</Link>
            </div>
          </div>
        </div>
        <div className="cluster">
          <span className="pill" style={{ color: show.agentOnline ? 'var(--ok)' : 'var(--danger)', borderColor: show.agentOnline ? '#1f4d36' : '#5a2323' }}>
            <span className="dot" />
            {show.agentOnline ? 'Show laptop online' : 'Show laptop offline'}
          </span>
          <button
            className={`btn ${st?.locked ? 'outline-accent' : ''}`}
            aria-pressed={Boolean(st?.locked)}
            onClick={() => sendOp({ type: 'lock', on: !st?.locked })}
            disabled={!st}
          >
            <Lock /> {st?.locked ? 'Remote control locked' : 'Lock remote control'}
          </button>
        </div>
      </header>

      <main className="main">
        <section className="col-main">
          <div className="card">
            <div className="card-head">
              <span className="eyebrow">On screen now · program output</span>
              <span className="muted" style={{ fontSize: 13 }}>
                Control: <span style={{ color: remoteActive ? 'var(--accent)' : 'var(--text)', fontWeight: 500 }}>{remoteActive ? controllerInvite?.display_name : 'Operator only'}</span>
              </span>
            </div>
            <SlideView url={cur?.url} aspect={aspect} number={pos?.slide ?? null} title={cur?.title ?? (st?.inShow ? null : st?.deck ? 'Slideshow not running' : 'No deck open')}>
              {laserVisible && laser ? (
                <span
                  className="laser-dot"
                  style={{
                    left: `${laser.x * 100}%`,
                    top: `${laser.y * 100}%`,
                    width: st?.laser.size === 'S' ? 12 : st?.laser.size === 'L' ? 26 : 18,
                    height: st?.laser.size === 'S' ? 12 : st?.laser.size === 'L' ? 26 : 18,
                    background: st?.laser.color ?? '#FF4D4D',
                    boxShadow: 'none',
                  }}
                />
              ) : null}
              {st?.blank ? <div className="overlay blank">Screen blanked</div> : null}
            </SlideView>
            <div className="row" style={{ alignItems: 'stretch', gap: 10 }}>
              <button className="btn" style={{ height: 52 }} onClick={() => sendOp({ type: 'nav', op: 'back' })} disabled={!st?.inShow || (st ? isAtStart(st) : true)}>
                <ChevronLeft /> Back
              </button>
              <div className="well" style={{ minWidth: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 12px' }}>
                <span className="mono" style={{ fontSize: 20, fontWeight: 500 }}>{pos ? `${pos.slide} / ${st?.deck?.slideCount ?? '?'}` : '– / –'}</span>
                <span className="muted" style={{ fontSize: 12 }}>{pos && pos.build !== null && buildCount ? `build ${pos.build} / ${buildCount}` : 'no builds'}</span>
              </div>
              <button
                className="btn outline-accent"
                style={{ flex: '1 1 180px', height: 52, fontSize: 16, fontWeight: 600 }}
                onClick={() => sendOp({ type: 'nav', op: 'next' })}
                disabled={!st?.inShow || (st ? isAtEnd(st) : true)}
              >
                Next (operator) <ChevronRight />
              </button>
              {st && !st.inShow && st.deck ? (
                <button className="btn primary" style={{ height: 52 }} onClick={() => sendOp({ type: 'start_show' })}>Start slideshow</button>
              ) : null}
              <button className={`btn ${st?.blank ? 'on' : ''}`} style={{ height: 52 }} aria-pressed={Boolean(st?.blank)} onClick={() => sendOp({ type: 'blank', on: !st?.blank })} disabled={!st?.inShow}>
                {st?.blank ? 'Unblank' : 'Blank'}
              </button>
            </div>
            <span className="faint" style={{ fontSize: 13 }}>Operator clicks always go through, even when remote control is locked. They are logged like any other click.</span>
          </div>

          <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
            <TimerCard state={st} receivedAt={show.receivedAt} now={now} sendOp={sendOp} sessionId={session.id} />
            <MessageCard
              sessionId={session.id}
              invites={invites}
              defaultInvite={st?.controller ?? invites[0]?.id ?? null}
              messages={messages}
              senders={senders}
              onChange={loadMessages}
              onError={setToast}
            />
          </div>

          <div className="card">
            <div className="card-head">
              <span className="eyebrow">Click log</span>
              <span className="faint" style={{ fontSize: 13 }}>Each command carries the slide·build the sender saw, so resends can’t skip a slide</span>
            </div>
            <div className="table-wrap">
              <table className="log">
                <thead>
                  <tr><th>Time</th><th>From</th><th>Command</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {log.length === 0 ? (
                    <tr><td colSpan={4} className="faint">No clicks yet.</td></tr>
                  ) : (
                    log.map((r, i) => (
                      <tr key={`${r.at}-${i}`}>
                        <td className="mono faint" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.at)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{r.source}</td>
                        <td className="mono">{r.command}</td>
                        <td><span className={`chip ${r.kind === 'ok' ? 'ok' : r.kind === 'dup' ? 'info' : r.kind === 'blocked' ? 'warn' : r.kind === 'error' ? 'bad' : 'neutral'}`}>{r.result}</span></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <aside className="col-side">
          <PairingCard sessionId={session.id} online={show.agentOnline} />

          <div className="card">
            <span className="eyebrow">Speakers</span>
            {st?.locked ? (
              <div className="chip warn" style={{ whiteSpace: 'normal', fontSize: 13 }}>Remote control is locked. Speaker clicks are logged and blocked.</div>
            ) : null}
            {invites.length === 0 ? (
              <span className="faint" style={{ fontSize: 13 }}>
                No speakers yet. Add them on the <Link to="/op">sessions page</Link>.
              </span>
            ) : null}
            {invites.map((inv) => (
              <SpeakerRow
                key={inv.id}
                sessionId={session.id}
                invite={inv}
                state={st}
                devices={presence[inv.id] ?? []}
                onPresence={(d) => setPresence((p) => ({ ...p, [inv.id]: d }))}
                onLaser={(pt) => {
                  if (inv.id !== st?.controller) return;
                  setLaser(pt.x === null || pt.y === null ? null : { x: pt.x, y: pt.y, at: Date.now() });
                }}
                onAck={() => void loadMessages()}
                register={(send) => {
                  senders.current[inv.id] = send;
                }}
                sendOp={sendOp}
              />
            ))}
          </div>

          <DeckCard sessionId={session.id} state={st} sendOp={sendOp} />
          <LaserCard state={st} sendOp={sendOp} />
          <ShowControlCard state={st} />
        </aside>
      </main>
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SpeakerRow({
  sessionId,
  invite,
  state,
  devices,
  onPresence,
  onLaser,
  onAck,
  register,
  sendOp,
}: {
  sessionId: string;
  invite: InviteRow;
  state: ShowState | null;
  devices: Device[];
  onPresence: (d: Device[]) => void;
  onLaser: (p: LaserPoint) => void;
  onAck: (a: MessageAck) => void;
  register: (send: Sender) => void;
  sendOp: (a: OperatorAction) => void;
}) {
  const ch = useChannel({
    topic: topics.speaker(sessionId, invite.id),
    handlers: {
      [EVENTS.speaker.laser]: (p: LaserPoint) => p && onLaser(p),
      [EVENTS.speaker.ack]: (a: MessageAck) => a && onAck(a),
    },
    onPresence: (ps: PresenceState) => {
      const list: Device[] = [];
      for (const metas of Object.values(ps)) {
        for (const m of metas) {
          if (m.role !== 'speaker') continue;
          list.push({ device: String(m.device ?? 'Browser'), phone: Boolean(m.phone), rtt: typeof m.rtt === 'number' ? m.rtt : null });
        }
      }
      onPresence(list);
    },
  });
  register(ch.send);

  const enabled = !state?.disabled.includes(invite.id);
  const inControl = state?.controller === invite.id;
  const online = devices.length > 0;
  let status = online ? 'Connected · view only' : 'Not connected';
  let statusColor = 'var(--text-2)';
  if (!enabled) {
    status = 'Disabled by operator';
    statusColor = 'var(--text-3)';
  } else if (inControl && state?.locked) {
    status = 'Has control · locked';
    statusColor = 'var(--accent)';
  } else if (inControl) {
    status = 'Has slide control';
    statusColor = 'var(--accent)';
  }
  const rtts = devices.map((d) => d.rtt).filter((r): r is number => r !== null);
  const bestRtt = rtts.length ? Math.min(...rtts) : null;

  return (
    <div className="well" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, borderColor: inControl && enabled && !state?.locked ? 'var(--accent)' : undefined }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: online && enabled ? 'var(--ok)' : '#5f646b', flex: 'none' }} />
          <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{invite.display_name}</span>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {online ? devices.map((d) => d.device).join(', ') : 'No device open'}
          {bestRtt !== null ? <span className="mono"> · {bestRtt} ms</span> : null}
        </span>
        <span style={{ fontSize: 12, color: statusColor }}>{status}</span>
      </div>
      <CopyButton text={inviteLink(invite.token)} label="Link" />
      <button className="btn small" disabled={!enabled || inControl || !state} onClick={() => sendOp({ type: 'controller', inviteId: invite.id })}>
        {inControl ? 'In control' : 'Give control'}
      </button>
      <Switch checked={enabled} label={`${enabled ? 'Disable' : 'Enable'} ${invite.display_name}`} onChange={(on) => sendOp({ type: 'enable', inviteId: invite.id, on })} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function TimerCard({
  state,
  receivedAt,
  now,
  sendOp,
  sessionId,
}: {
  state: ShowState | null;
  receivedAt: number;
  now: number;
  sendOp: (a: OperatorAction) => void;
  sessionId: string;
}) {
  const t = state?.timer;
  const v = t ? countdownView(t.lengthSec, elapsedFromSnapshot(t, receivedAt, now), t.started) : null;
  const lengths = [10, 15, 20, 30, 45];
  const setLength = (min: number) => {
    sendOp({ type: 'timer', action: 'length', seconds: min * 60 });
    void supabase.from('sessions').update({ talk_length_sec: min * 60 }).eq('id', sessionId);
  };
  return (
    <div className="card" style={{ flex: '1 1 300px' }}>
      <div className="card-head">
        <span className="eyebrow">Speaker timer</span>
        <span className="faint" style={{ fontSize: 12 }}>Same view as the speaker</span>
      </div>
      <div className={`countdown cd-${v?.phase ?? 'waiting'}`} style={{ height: 'auto', padding: '12px 14px', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="lbl">{v?.label ?? 'Waiting for show laptop'}</span>
          <span className="main-num" style={{ fontSize: 34 }}>{v?.text ?? '--:--'}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <span style={{ fontSize: 11 }}>elapsed</span>
          <span className="mono" style={{ fontSize: 14 }}>{v?.elapsedText ?? '--:--'}</span>
        </div>
      </div>
      <div className="row" role="group" aria-label="Talk length">
        <span className="muted" style={{ fontSize: 13 }}>Length</span>
        {lengths.map((m) => (
          <button key={m} className={`btn small mono ${t && t.lengthSec === m * 60 ? 'on' : ''}`} aria-pressed={Boolean(t && t.lengthSec === m * 60)} onClick={() => setLength(m)} disabled={!state}>
            {m}m
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn grow" onClick={() => sendOp({ type: 'timer', action: t?.running ? 'pause' : 'start' })} disabled={!state}>
          {t?.running ? 'Pause' : t?.started ? 'Resume' : 'Start now'}
        </button>
        <button className="btn mono" aria-label="Take one minute off the talk" onClick={() => sendOp({ type: 'timer', action: 'adjust', seconds: -60 })} disabled={!state}>−1 min</button>
        <button className="btn mono" aria-label="Add one minute to the talk" onClick={() => sendOp({ type: 'timer', action: 'adjust', seconds: 60 })} disabled={!state}>+1 min</button>
        <button className="btn" onClick={() => sendOp({ type: 'timer', action: 'reset' })} disabled={!state}>Reset</button>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="faint" style={{ fontSize: 12 }}>Start on the speaker’s first click · amber at 5 min · red at 1 min</span>
        <Switch checked={Boolean(t?.autoStart)} label="Start on first click" onChange={(on) => sendOp({ type: 'timer', action: 'autostart', on })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const QUICK = ['Wrap up please', '5 minutes left', 'Speak up a little', 'Slow down a bit', 'Look at the camera', 'Q&A is next'];

function MessageCard({
  sessionId,
  invites,
  defaultInvite,
  messages,
  senders,
  onChange,
  onError,
}: {
  sessionId: string;
  invites: InviteRow[];
  defaultInvite: string | null;
  messages: MessageRow[];
  senders: React.MutableRefObject<Record<string, Sender>>;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const to = target ?? defaultInvite;
  const names = useMemo(() => Object.fromEntries(invites.map((i) => [i.id, i.display_name])), [invites]);
  const current = messages.find((m) => m.status === 'delivered' && m.invite_id === to);

  async function send(text: string, isUrgent: boolean) {
    const body = text.trim();
    if (!body) return setErr('Type a message first');
    if (!to) return setErr('Add a speaker first');
    setErr(null);
    await supabase.from('messages').update({ status: 'replaced' }).eq('invite_id', to).eq('status', 'delivered');
    const { data, error } = await supabase
      .from('messages')
      .insert({ session_id: sessionId, invite_id: to, text: body.slice(0, 280), urgent: isUrgent })
      .select('id, created_at')
      .single();
    if (error || !data) return onError(errorText(error));
    await senders.current[to]?.(EVENTS.speaker.hostMsg, { id: data.id, text: body.slice(0, 280), urgent: isUrgent, at: data.created_at });
    setDraft('');
    setUrgent(false);
    onChange();
  }

  async function clear() {
    if (!current || !to) return;
    await supabase.from('messages').update({ status: 'cleared' }).eq('id', current.id);
    await senders.current[to]?.(EVENTS.speaker.hostMsgClear, { id: current.id });
    onChange();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft, urgent);
  }

  return (
    <div className="card" style={{ flex: '1 1 340px' }}>
      <div className="card-head">
        <span className="eyebrow">Message to speaker</span>
        {invites.length > 1 ? (
          <select className="input" style={{ width: 'auto', height: 36 }} value={to ?? ''} onChange={(e) => setTarget(e.target.value)} aria-label="Send to">
            {invites.map((i) => (
              <option key={i.id} value={i.id}>{i.display_name}</option>
            ))}
          </select>
        ) : (
          <span className="faint" style={{ fontSize: 12 }}>to {to ? names[to] : 'speaker'} · shows as a slim bar</span>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {QUICK.map((q) => (
          <button key={q} className="btn small" style={{ borderRadius: 999 }} onClick={() => void send(q, false)} disabled={!to}>
            {q}
          </button>
        ))}
      </div>
      <form onSubmit={onSubmit} noValidate>
        <label className="label" htmlFor="msg-input">Custom message</label>
        <div className="row">
          <input
            id="msg-input"
            className="input grow"
            placeholder="Keep it short"
            maxLength={280}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setErr(null);
            }}
          />
          <button type="button" className={`btn ${urgent ? 'danger' : ''}`} aria-pressed={urgent} onClick={() => setUrgent((u) => !u)}>Urgent</button>
          <button type="submit" className="btn primary">Send</button>
        </div>
        {err ? <div className="field-error">{err}</div> : null}
      </form>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="row" style={{ justifyContent: 'space-between', minHeight: 40 }}>
          <span className="faint" style={{ fontSize: 12 }}>Recent</span>
          {current ? <button className="btn small ghost" onClick={clear}>Clear from speaker screen</button> : null}
        </div>
        {messages.length === 0 ? <span className="faint" style={{ fontSize: 13 }}>No messages sent yet.</span> : null}
        {messages.map((m) => (
          <div key={m.id} className="row" style={{ flexWrap: 'nowrap', fontSize: 13, padding: '8px 0', borderTop: '1px solid var(--panel-2)' }}>
            <span className="mono faint" style={{ fontSize: 12 }}>{fmtTime(m.created_at)}</span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {invites.length > 1 ? <span className="faint">{names[m.invite_id] ?? 'Speaker'}: </span> : null}
              {m.text}
            </span>
            {m.urgent ? <span style={{ fontSize: 12, color: 'var(--danger-soft)' }}>urgent</span> : null}
            <span className={`chip ${m.status === 'delivered' ? 'info' : m.status === 'seen' ? 'ok' : 'neutral'}`}>
              {m.status === 'delivered' ? 'On screen' : m.status === 'seen' ? `Seen ${m.seen_at ? fmtTime(m.seen_at) : ''}` : m.status === 'cleared' ? 'Cleared' : 'Replaced'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PairingCard({ sessionId, online }: { sessionId: string; online: boolean }) {
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(1000);
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;

  if (online && !code) return null;

  return (
    <div className="card">
      <div className="card-head">
        <span className="eyebrow">Show laptop</span>
        <Laptop style={{ color: 'var(--text-2)' }} />
      </div>
      {online ? (
        <span className="chip ok"><span className="dot" />Connected. You can close this.</span>
      ) : (
        <span className="muted" style={{ fontSize: 14 }}>Open Slide Relay Agent on the show laptop and type this code.</span>
      )}
      {code && left > 0 ? (
        <div className="well" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="code-big">{code.code.slice(0, 3)} {code.code.slice(3)}</span>
          <span className="faint mono" style={{ fontSize: 12 }}>expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · single use</span>
        </div>
      ) : null}
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            setErr(null);
            const { data, error } = await supabase.rpc('create_agent_pairing', { p_session: sessionId });
            if (error || typeof data !== 'string') return setErr(errorText(error));
            setCode({ code: data, until: Date.now() + 10 * 60 * 1000 });
          }}
        >
          {code ? 'New code' : 'Connect show laptop'}
        </button>
        {code ? <button className="btn ghost small" onClick={() => setCode(null)}>Hide</button> : null}
      </div>
      {err ? <div className="field-error">{err}</div> : null}
    </div>
  );
}

function DeckCard({ sessionId, state, sendOp }: { sessionId: string; state: ShowState | null; sendOp: (a: OperatorAction) => void }) {
  const [uploads, setUploads] = useState<Array<DeckRow & { speaker: string }>>([]);
  useEffect(() => {
    supabase
      .from('decks')
      .select(`${DECK_COLUMNS}, invites(display_name)`)
      .eq('session_id', sessionId)
      .eq('source', 'upload')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        const rows = ((data ?? []) as unknown as Array<DeckRow & { invites: { display_name: string } | null }>).map((d) => ({
          ...d,
          speaker: d.invites?.display_name ?? 'Speaker',
        }));
        setUploads(rows);
      });
  }, [sessionId, state?.deck?.deckId]);

  async function download(d: DeckRow) {
    if (!d.storage_path) return;
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(d.storage_path, 300, { download: d.file_name });
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener');
  }

  const deck = state?.deck;
  return (
    <div className="card">
      <div className="card-head">
        <span className="eyebrow">Deck</span>
        <button className="btn small" onClick={() => sendOp({ type: 'resync' })} disabled={!state?.deck}>Re-sync from app</button>
      </div>
      <div className="grid-2">
        <span className="faint">File</span><span style={{ wordBreak: 'break-word' }}>{deck?.fileName ?? '–'}</span>
        <span className="faint">App</span><span>{APP_LABEL[state?.app ?? 'none']}</span>
        <span className="faint">Control method</span><span>{APP_METHOD[state?.app ?? 'none']}</span>
        <span className="faint">Slides</span>
        <span>{deck ? `${deck.slideCount} · ${deck.buildCounts.filter((b) => (b ?? 0) > 0).length} with builds` : '–'}</span>
        <span className="faint">Previews</span>
        <span style={{ color: deck?.deckId ? 'var(--ok)' : 'var(--text-2)' }}>{deck?.deckId ? 'Exported from the running app' : deck ? 'Exporting…' : '–'}</span>
        <span className="faint">Position</span><span className="mono">{formatPosition(state?.pos)}</span>
      </div>
      {uploads.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>Uploaded by speakers</span>
          {uploads.map((u) => (
            <div key={u.id} className="row" style={{ flexWrap: 'nowrap', fontSize: 13 }}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span className="faint">{u.speaker}: </span>
                {u.file_name}
              </span>
              <button className="btn small" onClick={() => download(u)}>Download</button>
            </div>
          ))}
          <span className="faint" style={{ fontSize: 12 }}>The agent can also download and open these from its Decks tab.</span>
        </div>
      ) : null}
    </div>
  );
}

function LaserCard({ state, sendOp }: { state: ShowState | null; sendOp: (a: OperatorAction) => void }) {
  const colors = [
    { hex: '#FF4D4D', label: 'Red dot' },
    { hex: '#3DD68C', label: 'Green dot' },
    { hex: '#FFB224', label: 'Amber dot' },
  ];
  const sizes: LaserSize[] = ['S', 'M', 'L'];
  return (
    <div className="card">
      <span className="eyebrow">Laser overlay</span>
      <span className="muted" style={{ fontSize: 13 }}>Click-through window on the show laptop’s output display</span>
      <div className="row" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 4 }} role="group" aria-label="Dot color">
          {colors.map((c) => (
            <button
              key={c.hex}
              className="btn icon-btn"
              aria-label={c.label}
              aria-pressed={state?.laser.color === c.hex}
              style={{ background: 'transparent', border: state?.laser.color === c.hex ? '2px solid var(--text)' : '1px solid var(--line)' }}
              onClick={() => sendOp({ type: 'laser_style', color: c.hex })}
              disabled={!state}
            >
              <span style={{ width: 18, height: 18, borderRadius: '50%', background: c.hex }} />
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Dot size">
          {sizes.map((s) => (
            <button key={s} aria-pressed={state?.laser.size === s} onClick={() => sendOp({ type: 'laser_style', size: s })} disabled={!state}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ShowControlCard({ state }: { state: ShowState | null }): ReactNode {
  const sc = state?.showControl;
  const cmds = ['/next', '/back', '/goto 4', '/blank', '/lock'];
  return (
    <div className="card">
      <span className="eyebrow">Show control</span>
      <span className="muted" style={{ fontSize: 13 }}>Trigger from Companion, a Stream Deck or your show controller, on the show laptop{sc?.lan ? ' or the show network' : ''}.</span>
      <div className="grid-2">
        <span className="faint">OSC</span><span className="mono">{sc?.oscPort ? `udp :${sc.oscPort}` : 'off'}</span>
        <span className="faint">HTTP</span><span className="mono">{sc?.httpPort ? `POST :${sc.httpPort}/api/{cmd}` : 'off'}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {cmds.map((c) => (
          <span key={c} className="mono" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, background: 'var(--panel-2)', border: '1px solid var(--line)' }}>{c}</span>
        ))}
      </div>
    </div>
  );
}
