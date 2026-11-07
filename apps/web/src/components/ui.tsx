import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { countdownView, elapsedFromSnapshot, type HostMessage, type TimerSnapshot } from '@rsc/protocol';
import { Bubble } from './Icons';

// ---------------------------------------------------------------------------
// Slide image in a fixed-aspect box. Children are layered on top (laser, overlays).
// ---------------------------------------------------------------------------

export function SlideView({
  url,
  aspect,
  number,
  title,
  children,
  style,
  className,
  ...handlers
}: {
  url: string | null | undefined;
  aspect: number;
  number?: number | null;
  title?: string | null;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={`slide-box ${className ?? ''}`} style={{ aspectRatio: String(aspect || 16 / 9), ...style }} {...handlers}>
      {url ? (
        <img src={url} alt={title ? `Slide ${number}: ${title}` : number ? `Slide ${number}` : 'Slide'} draggable={false} />
      ) : (
        <div className="slide-placeholder">
          {number ? <span className="big">{number}</span> : null}
          <span>{title || (number ? 'No preview yet' : 'No slide')}</span>
        </div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Countdown set by the host
// ---------------------------------------------------------------------------

export function Countdown({
  timer,
  receivedAt,
  now,
  compact = false,
}: {
  timer: TimerSnapshot | null | undefined;
  receivedAt: number;
  now: number;
  compact?: boolean;
}) {
  const t = timer ?? { lengthSec: 1200, elapsedMs: 0, running: false, autoStart: true, started: false };
  const elapsed = elapsedFromSnapshot(t, receivedAt, now);
  const v = countdownView(t.lengthSec, elapsed, t.started);
  if (compact) {
    return (
      <div className={`countdown cd-${v.phase}`} role="timer" aria-label={`${v.label} ${v.text}`} style={{ flexDirection: 'column', justifyContent: 'center', minWidth: 92 }}>
        <span className="main-num">{v.text}</span>
        <span style={{ fontSize: 11 }}>{v.phase === 'waiting' ? 'on 1st click' : v.phase === 'over' ? 'over' : 'left'}</span>
      </div>
    );
  }
  return (
    <div className={`countdown cd-${v.phase}`} role="timer" aria-label={`${v.label} ${v.text}`}>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 112 }}>
        <span className="lbl">{v.label}</span>
        <span className="main-num">{v.text}</span>
      </div>
      <div className="side">
        <span style={{ fontSize: 11 }}>elapsed</span>
        <span className="mono" style={{ fontSize: 13 }}>{v.elapsedText}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection pill
// ---------------------------------------------------------------------------

export type LinkQuality = 'live' | 'unstable' | 'reconnecting' | 'offline' | 'waiting';

export function ConnPill({ quality, rtt }: { quality: LinkQuality; rtt: number | null }) {
  const map: Record<LinkQuality, { color: string; border: string; text: string }> = {
    live: { color: 'var(--ok)', border: '#1f4d36', text: rtt !== null ? `Connected · ${rtt} ms` : 'Connected' },
    unstable: { color: 'var(--accent)', border: '#5a4313', text: `Unstable · ${rtt ?? '?'} ms` },
    reconnecting: { color: 'var(--danger)', border: '#5a2323', text: 'Reconnecting…' },
    offline: { color: 'var(--danger)', border: '#5a2323', text: 'Show laptop offline' },
    waiting: { color: 'var(--text-2)', border: 'var(--line)', text: 'Connecting…' },
  };
  const m = map[quality];
  return (
    <span className="pill" style={{ color: m.color, borderColor: m.border }} role="status">
      <span className="dot" />
      {m.text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Host message bar (never moves the controls: its slot is always reserved)
// ---------------------------------------------------------------------------

export function MessageBar({ msg, onAck, reserve = true }: { msg: HostMessage | null; onAck: () => void; reserve?: boolean }) {
  if (!msg) return reserve ? <div className="msgbar-spacer" aria-hidden="true" /> : null;
  const time = new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={`msgbar ${msg.urgent ? 'urgent' : ''}`} role="status" aria-live="polite">
      <Bubble style={{ flex: 'none', color: msg.urgent ? 'var(--danger)' : 'var(--info)' }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span className="from">Host{msg.urgent ? ' · urgent' : ''} · {time}</span>
        <span className="text" title={msg.text}>{msg.text}</span>
      </div>
      <button className="btn" style={{ flex: 'none', background: 'transparent', borderColor: msg.urgent ? '#7a2a2a' : '#2c4a75' }} onClick={onAck}>
        Got it
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span className="track"><span className="knob" /></span>
    </button>
  );
}

export function Toast({ text, onDone }: { text: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!text) return;
    const id = setTimeout(onDone, 3500);
    return () => clearTimeout(id);
  }, [text, onDone]);
  if (!text) return null;
  return <div className="toast" role="status">{text}</div>;
}

export function CopyButton({ text, label = 'Copy link' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          window.prompt('Copy this link', text);
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="center-page">
      <div className="card center-card">{children}</div>
    </div>
  );
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
