import { KEY, macKeys } from './osascript.js';
import type { PowerPointWindows } from './powerpoint-win.js';
import { emptyStatus, type Adapter, type AppStatus } from './types.js';

/**
 * Keystroke mode for anything that follows arrow keys: Google Slides presenting
 * in a browser, PDF viewers, web decks. Keys go to the foreground window, so the
 * presentation must be the active window. The app can't report its position, so
 * the agent counts clicks and marks the position as estimated.
 */
export class KeysAdapter implements Adapter {
  readonly kind = 'keys' as const;
  readonly canReadPosition = false;
  readonly canExportDuringShow = false;
  private slide = 1;
  private blank = false;

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly win: PowerPointWindows | null,
    private slideCount = 0,
  ) {}

  setSlideCount(n: number) {
    this.slideCount = Math.max(0, n);
  }

  resetPosition(slide = 1) {
    this.slide = Math.max(1, slide);
  }

  async status(): Promise<AppStatus> {
    const s = emptyStatus(this.kind);
    s.running = true;
    s.open = true;
    s.inShow = true;
    s.slide = this.slide;
    s.slideCount = this.slideCount;
    s.blank = this.blank;
    s.fileName = 'Keystroke mode';
    return s;
  }

  private async send(win: string, mac: Array<{ code?: number; text?: string }>) {
    if (this.platform === 'win32') {
      if (!this.win) throw new Error('Keystroke bridge not available');
      await this.win.keys(win);
    } else if (this.platform === 'darwin') {
      // Send to whatever is frontmost.
      await macKeys(null, mac);
    } else {
      throw new Error('Keystroke mode supports Windows and macOS');
    }
  }

  async next() {
    await this.send('{RIGHT}', [{ code: KEY.right }]);
    if (!this.slideCount || this.slide < this.slideCount) this.slide += 1;
  }

  async previous() {
    await this.send('{LEFT}', [{ code: KEY.left }]);
    this.slide = Math.max(1, this.slide - 1);
  }

  async goto(slide: number) {
    await this.send(`${slide}~`, [{ text: String(slide) }, { code: KEY.ret }]);
    this.slide = slide;
  }

  async setBlank(on: boolean) {
    if (on === this.blank) return;
    await this.send('b', [{ text: 'b' }]);
    this.blank = on;
  }

  async startShow() {
    this.slide = 1;
  }

  async buildCounts() {
    return Array.from({ length: this.slideCount }, () => null);
  }

  async exportDeck() {
    return [];
  }

  dispose() {}
}
