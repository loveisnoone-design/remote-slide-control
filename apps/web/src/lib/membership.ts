import { supabase } from './supabase';

export interface Membership {
  sessionId: string;
  inviteId: string;
  displayName: string;
  sessionName: string;
  room: string | null;
}

const KEY = 'rsc.memberships.v1';

function readAll(): Record<string, Membership> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Membership>;
  } catch {
    return {};
  }
}

export function saveMembership(m: Membership): void {
  try {
    const all = readAll();
    all[m.sessionId] = m;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private mode: the membership still works for this page view.
  }
}

/**
 * Which invite this browser holds for a session. Falls back to asking the
 * database (row level security only returns invites this user joined).
 */
export async function resolveMembership(sessionId: string): Promise<Membership | null> {
  const cached = readAll()[sessionId];
  if (cached) return cached;
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) return null;
  const [{ data: invites }, { data: sessions }] = await Promise.all([
    supabase.from('invites').select('id, display_name, session_id').eq('session_id', sessionId).limit(1),
    supabase.from('sessions').select('id, name, room').eq('id', sessionId).limit(1),
  ]);
  const inv = invites?.[0];
  const ses = sessions?.[0];
  if (!inv || !ses) return null;
  const m: Membership = {
    sessionId,
    inviteId: inv.id as string,
    displayName: inv.display_name as string,
    sessionName: ses.name as string,
    room: (ses.room as string | null) ?? null,
  };
  saveMembership(m);
  return m;
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const phone = /iPhone|Android.+Mobile|Mobile Safari/i.test(ua);
  const tablet = /iPad|Android(?!.*Mobile)/i.test(ua);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${phone ? 'phone' : tablet ? 'tablet' : 'computer'}`;
}
