import { readFile } from 'node:fs/promises';
import { findImages } from './keynote-mac.js';
import { KEY, as, isRunning, macKeys, osascript } from './osascript.js';
import { readPptxMeta } from '../pptx.js';
import { emptyStatus, type Adapter, type AppStatus, type ExportedSlide } from './types.js';

const APP = 'Microsoft PowerPoint';

const STATUS_AS = `
tell application "Microsoft PowerPoint"
  if (count of presentations) is 0 then return "open=0"
  set p to active presentation
  set fileName to name of p
  set fullPath to ""
  try
    set fullPath to full name of p
  end try
  set slideCount to count of slides of p
  set w to 0
  set h to 0
  try
    set w to slide width of page setup of p
    set h to slide height of page setup of p
  end try
  set inShow to 0
  set idx to 0
  if (count of slide show windows) > 0 then
    set inShow to 1
    try
      set idx to slide index of slide of slideshow view of slide show window 1
    end try
    if idx is 0 then
      try
        set idx to current show position of slideshow view of slide show window 1
      end try
    end if
  end if
  return "open=1" & linefeed & "inShow=" & inShow & linefeed & "slide=" & idx & linefeed & "count=" & slideCount & linefeed & "w=" & w & linefeed & "h=" & h & linefeed & "name=" & fileName & linefeed & "path=" & fullPath
end tell`;

/**
 * PowerPoint for Mac through AppleScript. Next/previous use the slideshow view;
 * jumping to a slide types the number + Return (PowerPoint's own shortcut),
 * which needs Accessibility permission. Notes come from the .pptx file itself.
 */
export class PowerPointMac implements Adapter {
  readonly kind = 'powerpoint-mac' as const;
  readonly canReadPosition = true;
  readonly canExportDuringShow = false;

  static async detect(): Promise<boolean> {
    return isRunning(APP);
  }

  async status(): Promise<AppStatus> {
    const s = emptyStatus(this.kind);
    if (!(await isRunning(APP))) return s;
    s.running = true;
    const out = await osascript(STATUS_AS, { timeoutMs: 4000 });
    const kv = parseKv(out);
    if (kv.open !== '1') return s;
    s.open = true;
    s.inShow = kv.inShow === '1';
    const idx = Number(kv.slide);
    s.slide = s.inShow && idx > 0 ? idx : null;
    s.slideCount = Number(kv.count) || 0;
    s.fileName = kv.name || null;
    s.filePath = kv.path ? hfsToPosix(kv.path) : null;
    const w = Number(String(kv.w).replace(',', '.'));
    const h = Number(String(kv.h).replace(',', '.'));
    s.aspect = w > 0 && h > 0 ? w / h : 16 / 9;
    return s;
  }

  async next() {
    await osascript(`tell application "Microsoft PowerPoint" to go to next slide (slideshow view of slide show window 1)`);
  }

  async previous() {
    await osascript(`tell application "Microsoft PowerPoint" to go to previous slide (slideshow view of slide show window 1)`);
  }

  async goto(slide: number) {
    await macKeys(APP, [{ text: String(slide) }, { code: KEY.ret }]);
  }

  async setBlank() {
    await macKeys(APP, [{ text: 'b' }]);
  }

  async startShow(fromSlide?: number) {
    await osascript(`tell application "Microsoft PowerPoint" to run slide show (slide show settings of active presentation)`, { timeoutMs: 15000 });
    if (fromSlide && fromSlide > 1) {
      await new Promise((r) => setTimeout(r, 600));
      await this.goto(fromSlide);
    }
  }

  async buildCounts(): Promise<Array<number | null>> {
    const s = await this.status();
    if (s.filePath && /\.pptx$/i.test(s.filePath)) {
      try {
        const meta = await readPptxMeta(await readFile(s.filePath));
        return meta.map((m) => m.builds);
      } catch {
        // fall through
      }
    }
    return Array.from({ length: s.slideCount }, () => null);
  }

  async exportDeck(outDir: string): Promise<ExportedSlide[]> {
    const s = await this.status();
    await osascript(`tell application "Microsoft PowerPoint" to save active presentation in (POSIX file ${as(outDir)}) as save as PNG`, { timeoutMs: 300_000 });
    const images = await findImages(outDir);
    let meta: Awaited<ReturnType<typeof readPptxMeta>> = [];
    if (s.filePath && /\.pptx$/i.test(s.filePath)) {
      try {
        meta = await readPptxMeta(await readFile(s.filePath));
      } catch {
        meta = [];
      }
    }
    const count = Math.max(s.slideCount, images.length);
    return Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      imagePath: images[i] ?? null,
      title: meta[i]?.title ?? null,
      notes: meta[i]?.notes ?? null,
      builds: meta[i]?.builds ?? null,
      hidden: meta[i]?.hidden ?? false,
    }));
  }

  dispose() {}
}

export function parseKv(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of out.split(/\r?\n|\r/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return kv;
}

/** PowerPoint for Mac reports "Macintosh HD:Users:me:deck.pptx" style paths. */
export function hfsToPosix(p: string): string {
  if (p.startsWith('/')) return p;
  const parts = p.split(':');
  if (parts.length < 2) return p;
  parts.shift(); // volume name (boot volume assumed)
  return `/${parts.join('/')}`;
}
