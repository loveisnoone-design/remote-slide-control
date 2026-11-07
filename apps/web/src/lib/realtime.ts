import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { EVENTS, isShowState, shouldAccept, topics, type ShowState } from '@rsc/protocol';
import { supabase } from './supabase';

export type ChannelStatus = 'connecting' | 'live' | 'error' | 'closed';

export type PresenceMeta = Record<string, unknown>;
export type PresenceState = Record<string, PresenceMeta[]>;

type Handler = (payload: any) => void;

interface ChannelOptions {
  topic: string | null;
  handlers: Record<string, Handler>;
  presenceKey?: string;
  presenceMeta?: PresenceMeta | null;
  onPresence?: (state: PresenceState) => void;
  onSubscribed?: () => void;
}

/**
 * Joins one private Supabase Realtime channel for the lifetime of the component.
 * Handlers can change every render without resubscribing; the event list is fixed
 * by the keys of `handlers` at mount.
 */
export function useChannel(opts: ChannelOptions) {
  const { topic } = opts;
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const chRef = useRef<RealtimeChannel | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const eventKey = Object.keys(opts.handlers).sort().join(',');
  const wantsPresence = Boolean(opts.onPresence || opts.presenceMeta);

  useEffect(() => {
    if (!topic) return;
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    setStatus('connecting');

    (async () => {
      const { data } = await supabase.auth.getSession();
      await supabase.realtime.setAuth(data.session?.access_token ?? null);
      if (cancelled) return;
      channel = supabase.channel(topic, {
        config: {
          private: true,
          broadcast: { self: false, ack: false },
          presence: { key: latest.current.presenceKey ?? '' },
        },
      });
      for (const ev of eventKey.split(',').filter(Boolean)) {
        channel.on('broadcast', { event: ev }, (msg: { payload?: unknown }) => {
          latest.current.handlers[ev]?.(msg.payload);
        });
      }
      if (wantsPresence) {
        channel.on('presence', { event: 'sync' }, () => {
          if (channel) latest.current.onPresence?.(channel.presenceState() as PresenceState);
        });
      }
      channel.subscribe(async (s) => {
        if (cancelled) return;
        if (s === 'SUBSCRIBED') {
          setStatus('live');
          const meta = latest.current.presenceMeta;
          if (meta && channel) await channel.track(meta);
          latest.current.onSubscribed?.();
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          setStatus('error');
        } else if (s === 'CLOSED') {
          setStatus('closed');
        }
      });
      chRef.current = channel;
    })();

    return () => {
      cancelled = true;
      chRef.current = null;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [topic, eventKey, wantsPresence]);

  const send = useCallback(async (event: string, payload: unknown): Promise<boolean> => {
    const ch = chRef.current;
    if (!ch) return false;
    const res = await ch.send({ type: 'broadcast', event, payload });
    return res === 'ok';
  }, []);

  const track = useCallback(async (meta: PresenceMeta) => {
    const ch = chRef.current;
    if (ch && status === 'live') await ch.track(meta);
  }, [status]);

  return { status, send, track };
}

/** The show laptop's state as broadcast on the session state channel. */
export function useShowState(sessionId: string | null) {
  const [state, setState] = useState<ShowState | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [deckVersion, setDeckVersion] = useState(0);
  const [lastSeen, setLastSeen] = useState(0);
  const stateRef = useRef<ShowState | null>(null);

  const ch = useChannel({
    topic: sessionId ? topics.state(sessionId) : null,
    handlers: {
      [EVENTS.state.state]: (payload: unknown) => {
        const t = Date.now();
        setLastSeen(t);
        if (!isShowState(payload)) return;
        if (!shouldAccept(stateRef.current, payload)) return;
        const deckChanged = stateRef.current?.deck?.deckId !== payload.deck?.deckId;
        stateRef.current = payload;
        setState(payload);
        setReceivedAt(t);
        if (deckChanged) setDeckVersion((v) => v + 1);
      },
      [EVENTS.state.deck]: () => setDeckVersion((v) => v + 1),
    },
  });

  const now = useNow(2000);
  // The agent sends a heartbeat every 5 s; 12 s of silence means it is gone.
  const agentOnline = lastSeen > 0 && now - lastSeen < 12_000;
  return { state, receivedAt, deckVersion, agentOnline, status: ch.status };
}

export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const l = () => setMatches(mq.matches);
    mq.addEventListener('change', l);
    l();
    return () => mq.removeEventListener('change', l);
  }, [query]);
  return matches;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
