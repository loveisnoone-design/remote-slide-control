import { useEffect, useState } from 'react';
import { BUCKET, supabase } from './supabase';

export interface SlideRow {
  n: number;
  image_path: string | null;
  title: string | null;
  notes: string | null;
  builds: number | null;
  hidden: boolean;
  url: string | null;
}

export interface DeckRow {
  id: string;
  session_id: string;
  invite_id: string | null;
  source: 'upload' | 'agent';
  file_name: string;
  storage_path: string | null;
  status: 'uploaded' | 'rendering' | 'ready' | 'failed' | 'needs_agent';
  progress: number;
  slide_count: number | null;
  aspect: number | null;
  app: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const DECK_COLUMNS =
  'id, session_id, invite_id, source, file_name, storage_path, status, progress, slide_count, aspect, app, error, created_at, updated_at';

/** Slide rows for a deck with signed image URLs (refreshed before they expire). */
export function useSlides(deckId: string | null, version = 0) {
  const [slides, setSlides] = useState<SlideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setRefresh((r) => r + 1), 45 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!deckId) {
      setSlides([]);
      return;
    }
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('slides')
        .select('n, image_path, title, notes, builds, hidden')
        .eq('deck_id', deckId)
        .order('n');
      if (cancelled) return;
      if (error || !data) {
        setLoading(false);
        return;
      }
      const paths = data.map((s) => s.image_path as string | null).filter((p): p is string => Boolean(p));
      const urls = new Map<string, string>();
      if (paths.length) {
        const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
        for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
      }
      if (cancelled) return;
      setSlides(
        data.map((s) => ({
          n: s.n as number,
          image_path: (s.image_path as string | null) ?? null,
          title: (s.title as string | null) ?? null,
          notes: (s.notes as string | null) ?? null,
          builds: (s.builds as number | null) ?? null,
          hidden: Boolean(s.hidden),
          url: s.image_path ? urls.get(s.image_path as string) ?? null : null,
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [deckId, version, refresh]);

  return { slides, loading };
}

/** The speaker's most recent uploaded deck that has finished rendering. */
export function useReadyUploadDeck(inviteId: string | null, version = 0) {
  const [deck, setDeck] = useState<DeckRow | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!inviteId) return;
    supabase
      .from('decks')
      .select(DECK_COLUMNS)
      .eq('invite_id', inviteId)
      .eq('source', 'upload')
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (!cancelled) setDeck(((data?.[0] as DeckRow | undefined) ?? null));
      });
    return () => {
      cancelled = true;
    };
  }, [inviteId, version]);
  return deck;
}

/**
 * Storage keys must be plain ASCII, so the path uses a cleaned name while the
 * deck row keeps the original (Thai and other scripts included) for display and
 * for matching the file the show laptop opens.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  if (!cleaned || cleaned.startsWith('.')) return `deck${cleaned}`;
  return cleaned;
}
