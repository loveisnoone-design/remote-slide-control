import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);

export const supabase = createClient(url || 'http://localhost:54321', key || 'not-configured', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  // The client throttles outgoing broadcasts; laser points need headroom above the default.
  realtime: { params: { eventsPerSecond: 30 } },
});

export const RENDERER_URL = ((import.meta.env.VITE_RENDERER_URL as string | undefined) || '').replace(/\/+$/, '');

export const BUCKET = 'decks';

/** Speakers and the agent use anonymous accounts; reuse any session already in this browser. */
export async function ensureSignedIn(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error || !created.user) throw error ?? new Error('Could not sign in');
  return created.user.id;
}

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export function isAnonymousUser(user: { is_anonymous?: boolean } | null | undefined): boolean {
  return Boolean(user?.is_anonymous);
}

export function errorText(e: unknown): string {
  if (!e) return 'Something went wrong';
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong';
}
