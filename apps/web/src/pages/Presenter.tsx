import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  EVENTS,
  LaserThrottle,
  isAtEnd,
  isAtStart,
  topics,
  type CommandResult,
  type HostMessage,
  type MessageAck,
  type RejectReason,
  type SpeakerCommand,
} from '@rsc/protocol';
import { supabase } from '../lib/supabase';
import { deviceLabel, resolveMembership, type Membership } from '../lib/membership';
import { newId, useChannel, useMediaQuery, useNow, useShowState } from '../lib/realtime';
import { useReadyUploadDeck, useSlides, type SlideRow } from '../lib/slides';
import { Link } from '../lib/router';
import { Centered, ConnPill, Countdown, MessageBar, SlideView, Toast, type LinkQuality } from '../components/ui';
import { Blank, ChevronLeft, ChevronRight, Crosshair } from '../components/Icons';

export function Presenter({ sessionId }: { sessionId: string }) {
  const [me, setMe] = useState<Membership | null | undefined>(undefined);
  useEffect(() => {
    resolveMembership(sessionId).then(setMe);
  }, [sessionId]);
  if (me === undefined) return <Centered><p className="muted" style={{ margin: 0 }}>Loading…</p></Centered>;
  if (me === null) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Open your speaker link</h1>
        <p className="muted" style={{ margin: 0 }}>This device hasn’t joined the session yet. Open the invite link the show team sent you.</p>
      </Centered>
    );
  }
  return <PresenterLive me={me} />;
}

function speakerReason(r: RejectReason): string {
  switch (r) {
    case 'stale':
      return 'The slide had already moved. Check the screen and try again.';
    case 'locked':
      return 'The host has locked remote control.';
    case 'no_control':
      return 'Waiting for the host to give you control.';
    case 'disabled':
      return 'The host has paused your control.';
    case 'no_show':
      return 'The slideshow isn’t running on the show laptop yet.';
    case 'at_end':
      return 'That’s the last slide.';
    case 'at_start':
      return 'That’s the first slide.';
    case 'out_of_range':
      return 'That slide doesn’t exist.';
    case 'app_error':
      return 'The presentation app didn’t respond. Try again, or ask the host.';
    case 'duplicate':
      return '';
  }
}

function PresenterLive({ me }: { me: Membership }) {
  const show = useShowState(me.sessionId);
  const st = show.state;
  const now = useNow(250);
  const isPhone = useMediaQuery('(max-width: 760px)');
  const tabId = useMemo(() => newId(), []);

  const [pending, setPending] = useState<{ id: string; at: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [lastPong, setLastPong] = useState(0);
  const [msg, setMsg] = useState<HostMessage | null>(null);
  const [laserOn, setLaserOn] = useState(false);
  const [dot, setDot] = useState<{ x: number; y: number } | null>(null);
  const [noteSize, setNoteSize] = useState(18);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const resendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRef = useRef<(event: string, payload: unknown) => Promise<boolean>>(async () => false);

  const spk = useChannel({
    topic: topics.speaker(me.sessionId, me.inviteId),
    presenceKey: `speaker:${tabId}`,
    presenceMeta: { role: 'speaker', name: me.displayName, device: deviceLabel(), phone: isPhone },
    handlers: {
      [EVENTS.speaker.result]: (r: CommandResult) => {
        if (!r || pendingRef.current?.id !== r.id) return;
        setPending(null);
        if (resendTimer.current) clearTimeout(resendTimer.current);
        if (!r.ok && r.reason && r.reason !== 'duplicate') setToast(speakerReason(r.reason));
      },
      [EVENTS.speaker.pong]: (p: { t: number }) => {
        if (!p || typeof p.t !== 'number') return;
        setRtt(Math.max(1, Math.round(Date.now() - p.t)));
        setLastPong(Date.now());
      },
      [EVENTS.speaker.hostMsg]: (m: HostMessage) => {
        if (m && typeof m.text === 'string') setMsg(m);
      },
      [EVENTS.speaker.hostMsgClear]: (c: { id: string }) => setMsg((cur) => (cur && c && cur.id === c.id ? null : cur)),
      // Another device of this speaker tapped "Got it".
      [EVENTS.speaker.ack]: (a: MessageAck) => setMsg((cur) => (cur && a && cur.id === a.id ? null : cur)),
    },
    onSubscribed: () => {
      void sendRef.current(EVENTS.speaker.hello, {});
      void sendRef.current(EVENTS.speaker.ping, { t: Date.now() });
    },
  });
  sendRef.current = spk.send;

  // Round-trip pings to the show laptop (not just to Supabase) every 5 s.
  useEffect(() => {
    const id = setInterval(() => void sendRef.current(EVENTS.speaker.ping, { t: Date.now() }), 5000);
    return () => clearInterval(id);
  }, []);

  // Keep the operator's view of this device's latency current.
  const trackRef = useRef(spk.track);
  trackRef.current = spk.track;
  const presenceRef = useRef({ rtt, isPhone });
  presenceRef.current = { rtt, isPhone };
  useEffect(() => {
    const id = setInterval(() => {
      const p = presenceRef.current;
      void trackRef.current({ role: 'speaker', name: me.displayName, device: deviceLabel(), phone: p.isPhone, rtt: p.rtt });
    }, 15000);
    return () => clearInterval(id);
  }, [me.displayName]);

  // A message sent while this device was away.
  useEffect(() => {
    supabase
      .from('messages')
      .select('id, text, urgent, created_at')
      .eq('invite_id', me.inviteId)
      .eq('status', 'delivered')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const m = data?.[0];
        if (m) setMsg({ id: m.id as string, text: m.text as string, urgent: Boolean(m.urgent), at: m.created_at as string });
      });
  }, [me.inviteId]);

  const ackMessage = useCallback(async () => {
    if (!msg) return;
    const id = msg.id;
    setMsg(null);
    void sendRef.current(EVENTS.speaker.ack, { id });
    await supabase.rpc('ack_message', { p_id: id });
  }, [msg]);

  // Slides: exact images from the show laptop when available, else this speaker's preview.
  const agentDeckId = st?.deck?.deckId ?? null;
  const uploadDeck = useReadyUploadDeck(agentDeckId ? null : me.inviteId, show.deckVersion);
  const deckId = agentDeckId ?? uploadDeck?.id ?? null;
  const { slides } = useSlides(deckId, show.deckVersion);
  const aspect = st?.deck?.aspect || uploadDeck?.aspect || 16 / 9;

  const pos = st?.pos ?? null;
  const slideCount = st?.deck?.slideCount || slides.length;
  const cur = pos ? slides.find((s) => s.n === pos.slide) : undefined;
  const buildCount = pos ? st?.deck?.buildCounts[pos.slide - 1] ?? null : null;
  const moreBuilds = Boolean(pos && pos.build !== null && buildCount !== null && buildCount !== undefined && pos.build < buildCount);

  let next: { slide: SlideRow | undefined; number: number | null; label: string; end: boolean };
  if (!pos) next = { slide: undefined, number: null, label: '–', end: false };
  else if (moreBuilds) next = { slide: cur, number: pos.slide, label: `Next click · build ${(pos.build ?? 0) + 1} / ${buildCount}`, end: false };
  else if (slideCount && pos.slide < slideCount) {
    const s = slides.find((x) => x.n === pos.slide + 1);
    next = { slide: s, number: pos.slide + 1, label: `Slide ${pos.slide + 1}${s?.title ? ` · ${s.title}` : ''}`, end: false };
  } else next = { slide: undefined, number: null, label: 'Last slide', end: true };

  // Link quality and permission.
  const linkUp = spk.status === 'live' && show.status === 'live';
  const pongFresh = lastPong > 0 && now - lastPong < 15_000;
  let quality: LinkQuality;
  if (!linkUp) quality = spk.status === 'connecting' && show.status === 'connecting' ? 'waiting' : 'reconnecting';
  else if (!show.agentOnline) quality = 'offline';
  else if (rtt !== null && (rtt > 400 || !pongFresh)) quality = 'unstable';
  else quality = 'live';
  const reachable = quality === 'live' || quality === 'unstable';

  const hasControl = Boolean(st && st.controller === me.inviteId && !st.locked && !st.disabled.includes(me.inviteId));
  const canDrive = Boolean(hasControl && st?.inShow && pos && reachable);
  let blocker: string | null = null;
  if (!st) blocker = 'Waiting for the show laptop to connect…';
  else if (!reachable) blocker = 'Can’t reach the show laptop. Clicks are paused so nothing gets sent twice.';
  else if (st.disabled.includes(me.inviteId)) blocker = 'The host has paused your control.';
  else if (st.locked) blocker = 'The host has locked remote control.';
  else if (st.controller !== me.inviteId) blocker = 'Waiting for the host to give you control.';
  else if (!st.inShow) blocker = 'The slideshow isn’t running on the show laptop yet.';

  const canDriveRef = useRef(canDrive);
  canDriveRef.current = canDrive;
  const posRef = useRef(pos);
  posRef.current = pos;
  const blankRef = useRef(Boolean(st?.blank));
  blankRef.current = Boolean(st?.blank);

  const sendCmd = useCallback((op: SpeakerCommand['op'], extra: Partial<SpeakerCommand> = {}) => {
    if (!canDriveRef.current || pendingRef.current) return;
    const p = posRef.current;
    const cmd: SpeakerCommand = { id: newId(), op, ...extra };
    if ((op === 'next' || op === 'back') && p) cmd.from = { slide: p.slide, build: p.build };
    setPending({ id: cmd.id, at: Date.now() });
    void sendRef.current(EVENTS.speaker.cmd, cmd);
    // One resend with the same id: the agent ignores it if the first one arrived.
    if (resendTimer.current) clearTimeout(resendTimer.current);
    resendTimer.current = setTimeout(() => {
      if (pendingRef.current?.id === cmd.id) void sendRef.current(EVENTS.speaker.cmd, cmd);
    }, 1200);
  }, []);

  useEffect(() => {
    if (pending && now - pending.at > 4000) {
      setPending(null);
      setToast('No answer from the show laptop. Check the screen and try again.');
    }
  }, [pending, now]);

  // Presentation clickers send arrow / page keys; B and . blank the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const onButton = t?.tagName === 'BUTTON';
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault();
          sendCmd('next');
          break;
        case ' ':
        case 'Enter':
          if (onButton) return;
          e.preventDefault();
          sendCmd('next');
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault();
          sendCmd('back');
          break;
        case 'b':
        case 'B':
        case '.':
          sendCmd('blank', { on: !blankRef.current });
          break;
        case 'l':
        case 'L':
          setLaserOn((v) => !v);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sendCmd]);

  // Laser
  const throttle = useRef<LaserThrottle | null>(null);
  if (!throttle.current) throttle.current = new LaserThrottle((p) => void sendRef.current(EVENTS.speaker.laser, p), 15);
  useEffect(() => () => throttle.current?.dispose(), []);
  useEffect(() => {
    if (!laserOn) {
      setDot(null);
      throttle.current?.push(null, null);
    }
  }, [laserOn]);
  useEffect(() => {
    if (!hasControl) setLaserOn(false);
  }, [hasControl]);
  // Holding still on a point: keep the dot alive on the output (the agent hides it after a pause).
  const dotRef = useRef(dot);
  dotRef.current = dot;
  useEffect(() => {
    if (!laserOn) return;
    const id = setInterval(() => {
      const d = dotRef.current;
      if (d) throttle.current?.push(d.x, d.y);
    }, 1000);
    return () => clearInterval(id);
  }, [laserOn]);

  const onPadMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!laserOn || !hasControl) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setDot({ x, y });
    throttle.current?.push(x, y);
  };
  const onPadLeave = () => {
    if (!laserOn) return;
    setDot(null);
    throttle.current?.push(null, null);
  };

  const atStart = st ? isAtStart(st) : true;
  const atEnd = st ? isAtEnd(st) : true;
  const counter = pos ? `${pos.slide} / ${slideCount || '?'}` : '– / –';
  const buildLabel = pos && pos.build !== null && buildCount ? `build ${pos.build} / ${buildCount}` : st?.app === 'keynote' ? 'builds not reported' : 'no builds';

  let ack: { cls: string; text: string };
  if (pending) ack = { cls: 'info', text: 'Sending · waiting for show laptop' };
  else if (!pos) ack = { cls: 'neutral', text: 'Nothing on screen yet' };
  else if (!reachable) ack = { cls: 'neutral', text: `Last confirmed · slide ${pos.slide}` };
  else if (st?.posEstimated) ack = { cls: 'warn', text: `Sent · slide ${pos.slide} (estimated, check the screen)` };
  else ack = { cls: 'ok', text: `Confirmed · slide ${pos.slide}${pos.build !== null && buildCount ? `, build ${pos.build} / ${buildCount}` : ''}` };

  const laserColor = st?.laser.color ?? '#FF4D4D';
  const readout = laserOn ? (dot ? `laser  x ${dot.x.toFixed(2)}  y ${dot.y.toFixed(2)}` : 'Laser on · move over the slide') : '';
  const fileLine = st?.deck?.fileName ? `${st.deck.fileName}` : uploadDeck?.file_name ?? 'No deck on the show laptop yet';

  const currentSlide = (
    <SlideView
      url={cur?.url}
      aspect={aspect}
      number={pos?.slide ?? null}
      title={cur?.title ?? null}
      onPointerMove={onPadMove}
      onPointerDown={onPadMove}
      onPointerLeave={onPadLeave}
      onPointerUp={isPhone ? onPadLeave : undefined}
      style={{
        cursor: laserOn ? 'crosshair' : 'default',
        touchAction: laserOn ? 'none' : 'auto',
        flex: 'none',
        // Keep Back/Next above the fold on short laptop screens.
        ...(isPhone ? {} : { maxWidth: `calc((100vh - 330px) * ${aspect})`, minWidth: 320, marginInline: 'auto' }),
      }}
      aria-label="Current slide. With the laser on, move over the slide to point."
    >
      {laserOn && dot ? (
        <span className="laser-dot" style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%`, width: 18, height: 18, background: laserColor }} />
      ) : null}
      {st?.blank ? <div className="overlay blank">Screen is blank in the venue</div> : null}
      {!reachable && st ? (
        <div className="overlay dim">
          <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--danger)' }}>{quality === 'offline' ? 'Show laptop offline' : 'Reconnecting…'}</span>
          <span className="muted" style={{ maxWidth: 420 }}>Controls are paused until the show laptop answers, so no click is sent twice.</span>
        </div>
      ) : null}
    </SlideView>
  );

  const laserButton = (
    <button className={`btn ${laserOn ? 'danger' : ''}`} aria-pressed={laserOn} onClick={() => setLaserOn((v) => !v)} disabled={!hasControl} style={isPhone ? { flex: 1 } : undefined}>
      <Crosshair /> {laserOn ? 'Laser on' : 'Laser'}
    </button>
  );
  const blankButton = (
    <button className={`btn ${st?.blank ? 'on' : ''}`} aria-pressed={Boolean(st?.blank)} onClick={() => sendCmd('blank', { on: !st?.blank })} disabled={!canDrive} style={isPhone ? { flex: 1 } : undefined}>
      <Blank /> {st?.blank ? 'Unblank' : isPhone ? 'Blank' : 'Blank screen'}
    </button>
  );

  if (isPhone) {
    return (
      <div className="phone">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me.room ? `${me.room} · ` : ''}
              {me.sessionName}
            </div>
            <div className="faint" style={{ fontSize: 12 }}>{me.displayName}</div>
          </div>
          <ConnPill quality={quality} rtt={rtt} />
        </div>
        {currentSlide}
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <span className={`chip ${ack.cls}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}><span className="dot" />{ack.text}</span>
          <span className="mono" style={{ flex: 'none', fontSize: 15 }}>{counter}</span>
        </div>
        {blocker ? <div className="chip warn" style={{ whiteSpace: 'normal' }}>{blocker}</div> : <div className="faint" style={{ fontSize: 13 }}>Next · {next.label}</div>}
        <MessageBar msg={msg} onAck={ackMessage} reserve={false} />
        <div className="card notes" style={{ padding: '12px 14px', gap: 6 }}>
          <span className="eyebrow" style={{ fontSize: 11 }}>Notes</span>
          <div style={{ fontSize: 17, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{cur?.notes || <span className="faint">No notes on this slide.</span>}</div>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          {laserButton}
          {blankButton}
          <Countdown timer={st?.timer} receivedAt={show.receivedAt} now={now} compact />
        </div>
        <div className="nav">
          <button className="btn back" aria-label="Back" onClick={() => sendCmd('back')} disabled={!canDrive || atStart}>
            <ChevronLeft size={28} />
          </button>
          <button className="btn primary next" onClick={() => sendCmd('next')} disabled={!canDrive || atEnd}>
            Next <ChevronRight size={28} />
          </button>
        </div>
        <Toast text={toast} onDone={() => setToast(null)} />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="who">
          <span className="role-tag">Speaker</span>
          <div style={{ minWidth: 0 }}>
            <div className="title">
              {me.room ? `${me.room} · ` : ''}
              {me.sessionName}
            </div>
            <div className="sub">
              {me.displayName} · {fileLine} · <Link to={`/s/${me.sessionId}/setup`}>Slides &amp; upload</Link>
            </div>
          </div>
        </div>
        <MessageBar msg={msg} onAck={ackMessage} />
        <div className="cluster">
          <ConnPill quality={quality} rtt={rtt} />
          <Countdown timer={st?.timer} receivedAt={show.receivedAt} now={now} />
        </div>
      </header>

      <main className="main">
        <section className="col-main" aria-label="Current slide">
          <div className="card-head">
            <div className="row">
              <span className="eyebrow">On screen</span>
              <span className={`chip ${ack.cls}`}><span className="dot" />{ack.text}</span>
            </div>
            <span className="mono faint" style={{ fontSize: 12 }}>{readout}</span>
          </div>
          {currentSlide}
          {blocker ? <div className="chip warn" style={{ whiteSpace: 'normal', alignSelf: 'flex-start', fontSize: 13 }}>{blocker}</div> : null}
          <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
            <button className="btn big" onClick={() => sendCmd('back')} disabled={!canDrive || atStart}>
              <ChevronLeft size={20} /> Back
            </button>
            <div className="well" style={{ minWidth: 132, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 14px' }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{counter}</span>
              <span className="muted" style={{ fontSize: 12 }}>{buildLabel}</span>
            </div>
            <button className="btn big primary" style={{ flex: '1 1 220px' }} onClick={() => sendCmd('next')} disabled={!canDrive || atEnd}>
              Next <ChevronRight size={22} />
            </button>
          </div>
          <div className="row" style={{ gap: 12 }}>
            {laserButton}
            {blankButton}
            <span className="faint" style={{ fontSize: 13 }}>Your USB clicker works here too: → / PgDn next, ← / PgUp back, B blank, L laser</span>
          </div>
        </section>

        <aside className="col-side">
          <div className="card">
            <div className="card-head">
              <span className="eyebrow">Next</span>
              <span className="muted" style={{ fontSize: 13 }}>{next.label}</span>
            </div>
            {next.end ? (
              <div className="slide-box" style={{ aspectRatio: String(aspect), border: '1px dashed var(--line-2)', background: 'transparent' }}>
                <div className="slide-placeholder">End of deck</div>
              </div>
            ) : (
              <SlideView url={next.slide?.url} aspect={aspect} number={next.number} title={next.slide?.title ?? null} />
            )}
          </div>
          <div className="card" style={{ flex: 1, minHeight: 240 }}>
            <div className="card-head">
              <span className="eyebrow">Notes · slide {pos?.slide ?? '–'}</span>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn small" style={{ width: 44 }} aria-label="Smaller notes text" onClick={() => setNoteSize((s) => Math.max(14, s - 2))}>A−</button>
                <button className="btn small" style={{ width: 44 }} aria-label="Larger notes text" onClick={() => setNoteSize((s) => Math.min(36, s + 2))}>A+</button>
              </div>
            </div>
            <div style={{ fontSize: noteSize, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowY: 'auto', maxHeight: 420 }}>
              {cur?.notes || <span className="faint" style={{ fontSize: 15 }}>No notes on this slide.</span>}
            </div>
          </div>
        </aside>

        <section className="full" aria-label="All slides" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="card-head">
            <span className="eyebrow">All slides</span>
            <span className="faint" style={{ fontSize: 13 }}>
              {agentDeckId ? 'Tap to jump · exact images from the show laptop' : uploadDeck ? 'Tap to jump · preview from your upload' : 'Slides appear once the deck is open on the show laptop'}
            </span>
          </div>
          <div className="thumbs">
            {slides.map((s) => (
              <button
                key={s.n}
                className="thumb"
                aria-current={pos?.slide === s.n}
                aria-label={`Go to slide ${s.n}${s.title ? `: ${s.title}` : ''}`}
                onClick={() => sendCmd('goto', { slide: s.n })}
                disabled={!canDrive}
              >
                <SlideView url={s.url} aspect={aspect} number={s.n} title={s.title} />
                <div className="cap">
                  <span className="mono" style={{ color: pos?.slide === s.n ? 'var(--accent)' : 'var(--text-2)' }}>{s.n}</span>
                  <span>{s.hidden ? 'hidden' : s.title ?? ''}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </main>
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
