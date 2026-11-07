import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KEY, isRunning, js, macKeys, osascript } from './osascript.js';
import { cleanText, emptyStatus, type Adapter, type AppStatus, type ExportedSlide } from './types.js';

const STATUS_JXA = `
function run() {
  const k = Application('Keynote');
  if (!k.running()) return JSON.stringify({ running: false });
  const docs = k.documents();
  if (!docs.length) return JSON.stringify({ running: true, open: false });
  const d = k.documents[0];
  let slide = null;
  try { slide = d.currentSlide().slideNumber(); } catch (e) {}
  let file = null;
  try { const f = d.file(); file = f ? f.toString() : null; } catch (e) {}
  let playing = false;
  try { playing = k.playing(); } catch (e) {}
  return JSON.stringify({
    running: true, open: true, inShow: playing, slide: slide,
    slideCount: d.slides.length, fileName: d.name(), filePath: file,
    w: d.width(), h: d.height()
  });
}`;

/**
 * Keynote through JXA. Keynote does not report build steps or the black-screen
 * state, so builds are unknown (null) and blank is tracked by the agent.
 */
export class KeynoteMac implements Adapter {
  readonly kind = 'keynote' as const;
  readonly canReadPosition = true;
  // Exporting images from a document that is playing can interrupt the show.
  readonly canExportDuringShow = false;

  static async detect(): Promise<boolean> {
    return isRunning('Keynote');
  }

  async status(): Promise<AppStatus> {
    const raw = JSON.parse(await osascript(STATUS_JXA, { jxa: true, timeoutMs: 4000 })) as {
      running: boolean;
      open?: boolean;
      inShow?: boolean;
      slide?: number | null;
      slideCount?: number;
      fileName?: string;
      filePath?: string | null;
      w?: number;
      h?: number;
    };
    const s = emptyStatus(this.kind);
    s.running = raw.running;
    s.open = Boolean(raw.open);
    if (!s.open) return s;
    s.inShow = Boolean(raw.inShow);
    s.slide = typeof raw.slide === 'number' ? raw.slide : null;
    s.slideCount = raw.slideCount ?? 0;
    s.fileName = raw.fileName ?? null;
    s.filePath = raw.filePath ?? null;
    s.aspect = raw.w && raw.h ? raw.w / raw.h : 16 / 9;
    return s;
  }

  async next() {
    await osascript(`Application('Keynote').showNext()`, { jxa: true });
  }

  async previous() {
    await osascript(`Application('Keynote').showPrevious()`, { jxa: true });
  }

  async goto(slide: number) {
    await osascript(`const k = Application('Keynote'); const d = k.documents[0]; k.start(d, { from: d.slides[${js(slide - 1)}] });`, { jxa: true });
  }

  async setBlank() {
    // Keynote toggles a black screen with "B" while playing.
    await macKeys('Keynote', [{ text: 'b' }]);
  }

  async startShow(fromSlide?: number) {
    const from = Math.max(1, fromSlide ?? 1);
    await osascript(`const k = Application('Keynote'); const d = k.documents[0]; k.start(d, { from: d.slides[${js(from - 1)}] });`, { jxa: true, timeoutMs: 15000 });
  }

  async buildCounts(): Promise<Array<number | null>> {
    const s = await this.status();
    return Array.from({ length: s.slideCount }, () => null);
  }

  async exportDeck(outDir: string): Promise<ExportedSlide[]> {
    const metaJson = await osascript(
      `
function run(argv) {
  const k = Application('Keynote');
  const d = k.documents[0];
  k.export(d, { to: Path(argv[0]), as: 'slide images', withProperties: { imageFormat: 'PNG', skippedSlides: true } });
  const out = [];
  const slides = d.slides();
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    let title = null, notes = null, skipped = false;
    try { title = s.defaultTitleItem().objectText(); } catch (e) {}
    try { notes = s.presenterNotes(); } catch (e) {}
    try { skipped = s.skipped(); } catch (e) {}
    out.push({ title: title, notes: notes, skipped: skipped });
  }
  return JSON.stringify(out);
}`,
      { jxa: true, args: [outDir], timeoutMs: 300_000 },
    );
    const meta = JSON.parse(metaJson) as Array<{ title: string | null; notes: string | null; skipped: boolean }>;
    const images = await findImages(outDir);
    return meta.map((m, i) => ({
      n: i + 1,
      imagePath: images[i] ?? null,
      title: cleanText(m.title),
      notes: cleanText(m.notes),
      builds: null,
      hidden: Boolean(m.skipped),
    }));
  }

  dispose() {}
}

/** PNGs under a folder (Keynote may add a sub-folder), in natural slide order. */
export async function findImages(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(d: string, depth: number) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 2) await walk(p, depth + 1);
      else if (e.isFile() && /\.png$/i.test(e.name)) found.push(p);
    }
  }
  await walk(dir, 0);
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

export { KEY };
