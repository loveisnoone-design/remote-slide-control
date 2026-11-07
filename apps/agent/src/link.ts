import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { EVENTS, topics, type LogEntry, type ShowState } from '@rsc/protocol';
import type { CoreTransport } from './core.js';
import type { FileKv } from './settings.js';

export function createAgentClient(url: string, key: string, storage: FileKv): SupabaseClient {
  return createClient(url, key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: {
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { eventsPerSecond: 60 },
    },
  });
}

export interface LinkHandlers {
  onSpeakerCommand: (inviteId: string, payload: unknown) => void;
  onLaser: (inviteId: string, payload: unknown) => void;
  onPing: (inviteId: string, payload: unknown) => void;
  onHello: (inviteId: string) => void;
  onOperatorAction: (payload: unknown) => void;
  onStatusChange: () => void;
}

export type LinkStatus = 'connecting' | 'live' | 'error' | 'unauthorized';

/**
 * The agent's realtime presence in one session: the state and op channels plus
 * one channel per speaker invite. Implements the core's transport.
 */
export class SessionLink implements CoreTransport {
  private readonly channels = new Map<string, RealtimeChannel>();
  private readonly status = new Map<string, string>();
  private stopped = false;
  private unauthorized = false;

  constructor(
    private readonly client: SupabaseClient,
    private readonly sessionId: string,
    private readonly h: LinkHandlers,
    private readonly log: (m: string) => void,
  ) {}

  async start(inviteIds: string[]): Promise<void> {
    await this.refreshAuth();
    this.join(topics.state(this.sessionId), (ch) => {
      // Nothing to receive on the state channel; the agent only publishes there.
      return ch;
    });
    this.join(topics.op(this.sessionId), (ch) =>
      ch.on('broadcast', { event: EVENTS.op.action }, (m: { payload?: unknown }) => this.h.onOperatorAction(m.payload)),
    );
    await this.setInvites(inviteIds);
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') void this.client.realtime.setAuth(session?.access_token ?? null);
    });
  }

  private async refreshAuth() {
    const { data } = await this.client.auth.getSession();
    await this.client.realtime.setAuth(data.session?.access_token ?? null);
  }

  async setInvites(inviteIds: string[]): Promise<void> {
    const wanted = new Set(inviteIds.map((id) => topics.speaker(this.sessionId, id)));
    for (const [topic, ch] of this.channels) {
      if (topic.includes(':spk:') && !wanted.has(topic)) {
        void this.client.removeChannel(ch);
        this.channels.delete(topic);
        this.status.delete(topic);
      }
    }
    for (const id of inviteIds) {
      const topic = topics.speaker(this.sessionId, id);
      if (this.channels.has(topic)) continue;
      this.join(topic, (ch) =>
        ch
          .on('broadcast', { event: EVENTS.speaker.cmd }, (m: { payload?: unknown }) => this.h.onSpeakerCommand(id, m.payload))
          .on('broadcast', { event: EVENTS.speaker.laser }, (m: { payload?: unknown }) => this.h.onLaser(id, m.payload))
          .on('broadcast', { event: EVENTS.speaker.ping }, (m: { payload?: unknown }) => this.h.onPing(id, m.payload))
          .on('broadcast', { event: EVENTS.speaker.hello }, () => this.h.onHello(id)),
      );
    }
  }

  private join(topic: string, setup: (ch: RealtimeChannel) => RealtimeChannel) {
    const ch = setup(this.client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false } } }));
    this.status.set(topic, 'connecting');
    ch.subscribe((s, err) => {
      if (this.stopped) return;
      this.status.set(topic, s);
      if (s === 'CHANNEL_ERROR') {
        const msg = err?.message ?? '';
        if (/unauthorized|not allowed|permission/i.test(msg)) this.unauthorized = true;
        this.log(`channel ${shortTopic(topic)}: ${msg || 'error'}`);
      }
      this.h.onStatusChange();
    });
    this.channels.set(topic, ch);
  }

  linkStatus(): LinkStatus {
    if (this.unauthorized) return 'unauthorized';
    const core = [topics.state(this.sessionId), topics.op(this.sessionId)].map((t) => this.status.get(t));
    if (core.every((s) => s === 'SUBSCRIBED')) return 'live';
    if (core.some((s) => s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED')) return 'error';
    return 'connecting';
  }

  private send(topic: string, event: string, payload: unknown) {
    const ch = this.channels.get(topic);
    if (!ch) return;
    void ch.send({ type: 'broadcast', event, payload }).catch(() => undefined);
  }

  broadcastState(s: ShowState): void {
    this.send(topics.state(this.sessionId), EVENTS.state.state, s);
  }

  broadcastDeck(deckId: string): void {
    this.send(topics.state(this.sessionId), EVENTS.state.deck, { deckId });
  }

  toSpeaker(inviteId: string, event: string, payload: unknown): void {
    this.send(topics.speaker(this.sessionId, inviteId), event, payload);
  }

  toOperator(event: string, payload: unknown): void {
    this.send(topics.op(this.sessionId), event, payload);
  }

  async storeLog(e: LogEntry): Promise<void> {
    const { error } = await this.client.from('click_log').insert({ session_id: this.sessionId, ...e });
    if (error) this.log(`click log: ${error.message}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const ch of this.channels.values()) await this.client.removeChannel(ch);
    this.channels.clear();
    this.status.clear();
  }
}

function shortTopic(t: string): string {
  return t.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (m) => m.slice(0, 8));
}
