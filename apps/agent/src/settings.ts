import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type AppMode = 'auto' | 'powerpoint' | 'keynote' | 'keys';

export interface Settings {
  supabaseUrl: string;
  anonKey: string;
  session: { id: string; name: string; room: string | null } | null;
  appMode: AppMode;
  /** Electron display id for the laser overlay, or null for "the external display". */
  overlayDisplayId: number | null;
  httpEnabled: boolean;
  httpPort: number;
  oscEnabled: boolean;
  oscPort: number;
  /** Accept show control from other machines on the network (HTTP then needs the token). */
  lan: boolean;
  token: string;
  exportWidth: number;
}

declare const __DEFAULT_SUPABASE_URL__: string;
declare const __DEFAULT_SUPABASE_KEY__: string;

export function defaults(): Settings {
  return {
    supabaseUrl: typeof __DEFAULT_SUPABASE_URL__ === 'string' ? __DEFAULT_SUPABASE_URL__ : '',
    anonKey: typeof __DEFAULT_SUPABASE_KEY__ === 'string' ? __DEFAULT_SUPABASE_KEY__ : '',
    session: null,
    appMode: 'auto',
    overlayDisplayId: null,
    httpEnabled: true,
    httpPort: 9001,
    oscEnabled: true,
    oscPort: 9000,
    lan: false,
    token: randomBytes(12).toString('base64url'),
    exportWidth: 1280,
  };
}

export class SettingsStore {
  private value: Settings;

  constructor(private readonly path: string) {
    let loaded: Partial<Settings> = {};
    try {
      loaded = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    } catch {
      loaded = {};
    }
    const base = defaults();
    this.value = { ...base, ...loaded };
    if (!this.value.supabaseUrl) this.value.supabaseUrl = base.supabaseUrl;
    if (!this.value.anonKey) this.value.anonKey = base.anonKey;
    if (!this.value.token) this.value.token = base.token;
    this.save();
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    this.save();
    return this.value;
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

/** Synchronous key/value file store for supabase-js auth tokens. */
export class FileKv {
  private data: Record<string, string>;

  constructor(private readonly path: string) {
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      this.data = {};
    }
  }

  getItem(key: string): string | null {
    return this.data[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.data[key] = value;
    this.flush();
  }

  removeItem(key: string): void {
    delete this.data[key];
    this.flush();
  }

  clear(): void {
    this.data = {};
    this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
  }
}

export function userFile(dir: string, name: string): string {
  return join(dir, name);
}
