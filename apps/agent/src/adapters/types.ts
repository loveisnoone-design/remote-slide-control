import type { AppKind } from '@rsc/protocol';

/** What the agent can read from the presentation app on each poll. */
export interface AppStatus {
  app: AppKind;
  /** The app process is running. */
  running: boolean;
  /** A presentation file is open. */
  open: boolean;
  /** A slideshow is playing. */
  inShow: boolean;
  /** 1-based slide on screen, or null when unknown. */
  slide: number | null;
  /** Click builds already played on this slide, or null when the app can't say. */
  build: number | null;
  /** Click builds on this slide, when the app reports it live. */
  buildCount: number | null;
  slideCount: number;
  fileName: string | null;
  filePath: string | null;
  /** Slide width / height. */
  aspect: number;
  /** Blank/black screen, when the app reports it; null when the agent must track it. */
  blank: boolean | null;
  /** The slideshow reached its "end of show" screen. */
  ended: boolean;
}

export interface ExportedSlide {
  n: number;
  imagePath: string | null;
  title: string | null;
  notes: string | null;
  builds: number | null;
  hidden: boolean;
}

export interface Adapter {
  readonly kind: AppKind;
  /** The agent reads position back after every command. False = keystroke mode, position is estimated. */
  readonly canReadPosition: boolean;
  /** Exporting slide images will not disturb a running slideshow. */
  readonly canExportDuringShow: boolean;
  status(): Promise<AppStatus>;
  next(): Promise<void>;
  previous(): Promise<void>;
  goto(slide: number): Promise<void>;
  setBlank(on: boolean): Promise<void>;
  startShow(fromSlide?: number): Promise<void>;
  /** Click builds per slide (index 0 = slide 1). */
  buildCounts(): Promise<Array<number | null>>;
  /** Write one PNG per slide into outDir and return slide metadata. */
  exportDeck(outDir: string, widthPx: number): Promise<ExportedSlide[]>;
  dispose(): void;
}

export function emptyStatus(app: AppKind): AppStatus {
  return {
    app,
    running: false,
    open: false,
    inShow: false,
    slide: null,
    build: null,
    buildCount: null,
    slideCount: 0,
    fileName: null,
    filePath: null,
    aspect: 16 / 9,
    blank: null,
    ended: false,
  };
}

/** PowerPoint uses \r between paragraphs and \v for line breaks. */
export function cleanText(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\r\n?|\u000b/g, '\n').replace(/\u0000/g, '').trim();
  return t.length ? t : null;
}
