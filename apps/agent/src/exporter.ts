import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Adapter } from './adapters/types.js';
import type { AgentCore, DeckIdentity } from './core.js';

const BUCKET = 'decks';

export type ExportPhase = 'idle' | 'waiting_for_show_end' | 'exporting' | 'uploading' | 'done' | 'failed';

export interface ExportStatus {
  phase: ExportPhase;
  fileName: string | null;
  done: number;
  total: number;
  error: string | null;
}

/**
 * Exports the open deck's slides and notes from the presentation app itself and
 * publishes them (Storage + public.decks/slides), so speakers see exactly what
 * the audience sees. Runs one export at a time; a newer file replaces a queued one.
 */
export class DeckExporter {
  private pending: DeckIdentity | null = null;
  private running = false;
  private st: ExportStatus = { phase: 'idle', fileName: null, done: 0, total: 0, error: null };

  constructor(
    private readonly client: SupabaseClient,
    private readonly sessionId: string,
    private readonly core: AgentCore,
    private readonly getAdapter: () => Adapter | null,
    private readonly resizePng: (file: string, width: number) => Promise<Buffer>,
    private readonly widthPx: () => number,
    private readonly onChange: () => void,
    private readonly log: (m: string) => void,
  ) {}

  status(): ExportStatus {
    return this.st;
  }

  private set(patch: Partial<ExportStatus>) {
    this.st = { ...this.st, ...patch };
    this.onChange();
  }

  /** A new file (or slide count) is open. */
  request(id: DeckIdentity): void {
    this.pending = id;
    void this.showExisting(id);
    void this.kick();
  }

  /** Called on every poll: starts a deferred export once the slideshow has stopped. */
  tick(inShow: boolean): void {
    if (this.st.phase === 'waiting_for_show_end' && !inShow) void this.kick();
  }

  /** Use a previous export of the same file right away, while the fresh one runs. */
  private async showExisting(id: DeckIdentity) {
    const { data } = await this.client
      .from('decks')
      .select('id, slide_count, status')
      .eq('session_id', this.sessionId)
      .eq('source', 'agent')
      .eq('file_name', id.fileName)
      .maybeSingle();
    if (data && data.status === 'ready' && data.slide_count === id.slideCount) {
      this.core.setDeckId(id.key, data.id as string);
    }
  }

  private async kick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const id = this.pending;
        const adapter = this.getAdapter();
        if (!adapter || adapter.kind !== id.app) {
          this.pending = null;
          break;
        }
        if (!adapter.canExportDuringShow && this.core.snapshot().inShow) {
          this.set({ phase: 'waiting_for_show_end', fileName: id.fileName, done: 0, total: id.slideCount, error: null });
          return;
        }
        this.pending = null;
        await this.exportOne(adapter, id);
      }
    } finally {
      this.running = false;
    }
  }

  private async exportOne(adapter: Adapter, id: DeckIdentity) {
    const dir = await mkdtemp(join(tmpdir(), 'slide-relay-'));
    this.set({ phase: 'exporting', fileName: id.fileName, done: 0, total: id.slideCount, error: null });
    try {
      const deckId = await this.deckRow(id);
      // Not queued behind the core: on Windows the export runs in its own PowerShell
      // process, so speaker clicks keep flowing between slide exports.
      const slides = await adapter.exportDeck(dir, this.widthPx());
      if (this.pending && this.pending.key !== id.key) return; // a different file opened meanwhile
      this.set({ phase: 'uploading', total: slides.length, done: 0 });

      const rows: Array<Record<string, unknown>> = [];
      let done = 0;
      const queue = [...slides];
      const worker = async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          let imagePath: string | null = null;
          if (s.imagePath) {
            const png = await this.resizePng(s.imagePath, this.widthPx()).catch(() => readFile(s.imagePath!));
            imagePath = `${this.sessionId}/agent/${deckId}/${s.n}.png`;
            const { error } = await this.client.storage.from(BUCKET).upload(imagePath, png, { contentType: 'image/png', upsert: true, cacheControl: '60' });
            if (error) throw new Error(`upload slide ${s.n}: ${error.message}`);
          }
          rows.push({ deck_id: deckId, n: s.n, image_path: imagePath, title: s.title, notes: s.notes, builds: s.builds, hidden: s.hidden });
          done += 1;
          if (done % 3 === 0 || done === slides.length) {
            this.set({ done });
            await this.client.from('decks').update({ progress: Math.round((done / slides.length) * 100) }).eq('id', deckId);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);

      rows.sort((a, b) => (a.n as number) - (b.n as number));
      const { error: upErr } = await this.client.from('slides').upsert(rows, { onConflict: 'deck_id,n' });
      if (upErr) throw new Error(`slides: ${upErr.message}`);
      await this.client.from('slides').delete().eq('deck_id', deckId).gt('n', slides.length);
      await this.client
        .from('decks')
        .update({ status: 'ready', progress: 100, slide_count: slides.length, aspect: id.aspect, app: id.app, error: null })
        .eq('id', deckId);
      this.core.setDeckId(id.key, deckId);
      this.set({ phase: 'done', done: slides.length });
      this.log(`exported ${slides.length} slides from ${id.fileName}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.set({ phase: 'failed', error: msg });
      this.log(`export failed: ${msg}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Find or create this file's agent deck row. */
  private async deckRow(id: DeckIdentity): Promise<string> {
    const { data: existing } = await this.client
      .from('decks')
      .select('id')
      .eq('session_id', this.sessionId)
      .eq('source', 'agent')
      .eq('file_name', id.fileName)
      .maybeSingle();
    if (existing?.id) {
      await this.client.from('decks').update({ status: 'rendering', progress: 0, error: null }).eq('id', existing.id);
      return existing.id as string;
    }
    const deckId = randomUUID();
    const { error } = await this.client.from('decks').insert({
      id: deckId,
      session_id: this.sessionId,
      source: 'agent',
      file_name: id.fileName,
      status: 'rendering',
      progress: 0,
      slide_count: id.slideCount,
      aspect: id.aspect,
      app: id.app,
    });
    if (error) throw new Error(`deck: ${error.message}`);
    return deckId;
  }
}
