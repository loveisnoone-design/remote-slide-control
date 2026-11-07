/**
 * Realtime channel names. Every channel is a Supabase *private* channel; the
 * access rules in supabase/migrations check these exact shapes.
 *
 *   rsc:<session>:state           agent → everyone      (show state, deck updates)
 *   rsc:<session>:op              operator ↔ agent      (operator actions, click log)
 *   rsc:<session>:spk:<invite>    one speaker ↔ agent/operator (commands, laser, messages)
 *
 * A speaker can only publish on its own channel, so the agent knows who sent a
 * command from the channel it arrived on — the payload cannot impersonate anyone.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOPIC_RE = new RegExp(`^rsc:(${UUID}):(state|op|spk:(${UUID}))$`);

export const topics = {
  state: (sessionId: string) => `rsc:${sessionId}:state`,
  op: (sessionId: string) => `rsc:${sessionId}:op`,
  speaker: (sessionId: string, inviteId: string) => `rsc:${sessionId}:spk:${inviteId}`,
};

export type ParsedTopic =
  | { kind: 'state'; sessionId: string }
  | { kind: 'op'; sessionId: string }
  | { kind: 'speaker'; sessionId: string; inviteId: string };

export function parseTopic(topic: string): ParsedTopic | null {
  const m = TOPIC_RE.exec(topic);
  if (!m) return null;
  const sessionId = m[1]!;
  if (m[2] === 'state') return { kind: 'state', sessionId };
  if (m[2] === 'op') return { kind: 'op', sessionId };
  return { kind: 'speaker', sessionId, inviteId: m[3]! };
}
