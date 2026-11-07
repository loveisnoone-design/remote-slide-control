import { asArray, JsonLineBridge } from './bridge.js';
import { cleanText, emptyStatus, type Adapter, type AppStatus, type ExportedSlide } from './types.js';

interface RawStatus {
  running?: boolean;
  open?: boolean;
  inShow?: boolean;
  blank?: boolean;
  ended?: boolean;
  slide?: number | null;
  click?: number;
  clickCount?: number;
  slideCount?: number;
  fileName?: string;
  fullName?: string;
  slideW?: number;
  slideH?: number;
}

interface RawSlide {
  n: number;
  image: string;
  title: string | null;
  notes: string | null;
  hidden: boolean;
  builds: number;
}

/** PowerPoint on Windows through COM, via the PowerShell bridge. */
export class PowerPointWindows implements Adapter {
  readonly kind = 'powerpoint-win' as const;
  readonly canReadPosition = true;
  readonly canExportDuringShow = true;

  constructor(private readonly bridge: JsonLineBridge) {}

  static create(scriptPath: string, log: (m: string) => void): PowerPointWindows {
    const bridge = new JsonLineBridge(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      log,
    );
    return new PowerPointWindows(bridge);
  }

  async status(): Promise<AppStatus> {
    const r = await this.bridge.request<RawStatus>('status', {}, 4000);
    const s = emptyStatus(this.kind);
    s.running = Boolean(r.running);
    s.open = Boolean(r.open);
    if (!s.open) return s;
    s.inShow = Boolean(r.inShow);
    s.slideCount = Number(r.slideCount) || 0;
    s.fileName = r.fileName ?? null;
    s.filePath = r.fullName ?? null;
    s.aspect = r.slideW && r.slideH ? r.slideW / r.slideH : 16 / 9;
    s.blank = s.inShow ? Boolean(r.blank) : false;
    s.ended = Boolean(r.ended);
    if (s.inShow) {
      if (typeof r.slide === 'number') s.slide = r.slide;
      else if (s.ended) s.slide = s.slideCount; // "End of slide show" screen
      s.build = typeof r.click === 'number' ? r.click : null;
      s.buildCount = typeof r.clickCount === 'number' ? r.clickCount : null;
      if (s.ended && s.buildCount !== null) s.build = s.buildCount;
    }
    return s;
  }

  async next() {
    await this.bridge.request('next');
  }

  async previous() {
    await this.bridge.request('previous');
  }

  async goto(slide: number) {
    await this.bridge.request('goto', { slide });
  }

  async setBlank(on: boolean) {
    await this.bridge.request('blank', { on });
  }

  async startShow(fromSlide?: number) {
    await this.bridge.request('start', { from: fromSlide ?? 1 }, 15000);
  }

  async buildCounts(): Promise<Array<number | null>> {
    const r = await this.bridge.request<{ counts?: number[] | number }>('builds', {}, 20000);
    return asArray(r.counts).map((n) => (typeof n === 'number' ? n : null));
  }

  async exportDeck(outDir: string, widthPx: number): Promise<ExportedSlide[]> {
    const r = await this.bridge.request<{ slides?: RawSlide[] | RawSlide }>('export', { dir: outDir, width: widthPx }, 300_000);
    return asArray(r.slides).map((s) => ({
      n: s.n,
      imagePath: s.image ?? null,
      title: cleanText(s.title),
      notes: cleanText(s.notes),
      builds: typeof s.builds === 'number' ? s.builds : null,
      hidden: Boolean(s.hidden),
    }));
  }

  /** SendKeys to the foreground window, for keystroke mode on Windows. */
  async keys(keys: string) {
    await this.bridge.request('keys', { keys });
  }

  dispose() {
    this.bridge.dispose();
  }
}
