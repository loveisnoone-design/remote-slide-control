import { app, BrowserWindow, ipcMain, nativeImage, screen, shell, systemPreferences, type Display } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LaserStyle, LogEntry, OperatorAction } from '@rsc/protocol';
import { AgentCore } from './core.js';
import { SessionLink, createAgentClient } from './link.js';
import { DeckExporter } from './exporter.js';
import { ShowControl } from './showcontrol.js';
import { FileKv, SettingsStore, type AppMode, type Settings } from './settings.js';
import type { Adapter } from './adapters/types.js';
import { PowerPointWindows } from './adapters/powerpoint-win.js';
import { PowerPointMac } from './adapters/powerpoint-mac.js';
import { KeynoteMac } from './adapters/keynote-mac.js';
import { KeysAdapter } from './adapters/keys.js';

// ---------------------------------------------------------------------------
// Paths and single instance
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) app.quit();

const userDir = app.getPath('userData');
const settings = new SettingsStore(join(userDir, 'settings.json'));
const authStore = new FileKv(join(userDir, 'auth.json'));
const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources');
const uiDir = join(app.getAppPath(), 'ui');
const distDir = join(app.getAppPath(), 'dist');

const logLines: string[] = [];
function log(m: string) {
  const line = `${new Date().toLocaleTimeString()}  ${m}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  console.log(line);
  pushStatus();
}

// ---------------------------------------------------------------------------
// Presentation app adapters
// ---------------------------------------------------------------------------

let winPpt: PowerPointWindows | null = null;
let winPptExport: PowerPointWindows | null = null;
let macPpt: PowerPointMac | null = null;
let keynote: KeynoteMac | null = null;
let keys: KeysAdapter | null = null;
let current: Adapter | null = null;

function bridgeScript() {
  return join(resourcesDir, 'ppt-bridge.ps1');
}

function windowsPpt(): PowerPointWindows {
  if (!winPpt) winPpt = PowerPointWindows.create(bridgeScript(), (m) => log(`PowerPoint bridge: ${m}`));
  return winPpt;
}

/** A second bridge process so exporting slides never blocks clicks. */
function windowsPptExport(): PowerPointWindows {
  if (!winPptExport) winPptExport = PowerPointWindows.create(bridgeScript(), (m) => log(`Export bridge: ${m}`));
  return winPptExport;
}

function keysAdapter(): KeysAdapter {
  if (!keys) keys = new KeysAdapter(process.platform, process.platform === 'win32' ? windowsPpt() : null);
  return keys;
}

async function chooseAdapter(mode: AppMode): Promise<Adapter | null> {
  if (mode === 'keys') return keysAdapter();
  if (process.platform === 'win32') {
    if (mode === 'keynote') return null;
    return windowsPpt();
  }
  if (process.platform === 'darwin') {
    macPpt ??= new PowerPointMac();
    keynote ??= new KeynoteMac();
    if (mode === 'powerpoint') return macPpt;
    if (mode === 'keynote') return keynote;
    // auto: keep the current app while it runs; otherwise prefer whichever is running.
    if (current && current.kind !== 'keys' && (current.kind === 'keynote' ? await KeynoteMac.detect() : await PowerPointMac.detect())) return current;
    if (await PowerPointMac.detect()) return macPpt;
    if (await KeynoteMac.detect()) return keynote;
    return null;
  }
  return null;
}

function exportAdapter(): Adapter | null {
  if (current?.kind === 'powerpoint-win') return windowsPptExport();
  return current;
}

// ---------------------------------------------------------------------------
// Laser overlay
// ---------------------------------------------------------------------------

let overlay: BrowserWindow | null = null;
let overlayDisplay: Display | null = null;
let overlayHideTimer: NodeJS.Timeout | null = null;

function targetDisplay(): Display {
  const all = screen.getAllDisplays();
  const chosen = all.find((d) => d.id === settings.get().overlayDisplayId);
  if (chosen) return chosen;
  // The slideshow usually runs on the external output.
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id !== primary.id) ?? primary;
}

function ensureOverlay(): BrowserWindow {
  const d = targetDisplay();
  if (overlay && !overlay.isDestroyed() && overlayDisplay?.id === d.id) return overlay;
  overlay?.destroy();
  overlayDisplay = d;
  overlay = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    // A panel can sit above another app's fullscreen space (Keynote/PowerPoint on macOS).
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { preload: join(distDir, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin') overlay.setFullScreenable(false);
  void overlay.loadFile(join(uiDir, 'overlay.html'));
  return overlay;
}

function drawLaser(p: { x: number; y: number } | null, style: LaserStyle, aspect: number) {
  if (!p) {
    overlay?.webContents.send('laser', { hide: true });
    return;
  }
  const win = ensureOverlay();
  if (!win.isVisible()) win.showInactive();
  win.webContents.send('laser', { x: p.x, y: p.y, color: style.color, size: style.size, aspect });
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  // Hide the window (not just the dot) after a pause so it never sits over the show.
  overlayHideTimer = setTimeout(() => {
    overlay?.webContents.send('laser', { hide: true });
    setTimeout(() => overlay?.hide(), 400);
  }, 4000);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;
let link: SessionLink | null = null;
let core: AgentCore | null = null;
let exporter: DeckExporter | null = null;
let showControl: ShowControl | null = null;
let invites = new Map<string, string>();
let timers: NodeJS.Timeout[] = [];
let connecting = false;

function getClient(): SupabaseClient | null {
  const s = settings.get();
  if (!s.supabaseUrl || !s.anonKey) return null;
  client ??= createAgentClient(s.supabaseUrl, s.anonKey, authStore);
  return client;
}

async function loadInvites(sessionId: string) {
  const c = getClient();
  if (!c) return;
  const { data, error } = await c.from('invites').select('id, display_name, revoked').eq('session_id', sessionId);
  if (error) {
    log(`invites: ${error.message}`);
    return;
  }
  invites = new Map((data ?? []).filter((i) => !i.revoked).map((i) => [i.id as string, i.display_name as string]));
  await link?.setInvites([...invites.keys()]);
}

async function connect(): Promise<void> {
  const s = settings.get();
  const c = getClient();
  if (!c || !s.session || connecting) return;
  connecting = true;
  try {
    await disconnect();
    const sessionId = s.session.id;
    core = new AgentCore({
      transport: {
        broadcastState: (st) => link?.broadcastState(st),
        broadcastDeck: (id) => link?.broadcastDeck(id),
        toSpeaker: (inv, ev, p) => link?.toSpeaker(inv, ev, p),
        toOperator: (ev, p) => link?.toOperator(ev, p),
      },
      getAdapter: () => current,
      storeLog: (e: LogEntry) => void link?.storeLog(e),
      laser: drawLaser,
      speakerName: (id) => invites.get(id) ?? 'Speaker',
      onDeckIdentity: (id) => exporter?.request(id),
      onResync: () => log('re-sync requested'),
      onInvitesChanged: () => void loadInvites(sessionId),
    });
    exporter = new DeckExporter(
      c,
      sessionId,
      core,
      exportAdapter,
      async (file, width) => {
        const img = nativeImage.createFromPath(file);
        if (img.isEmpty()) throw new Error('unreadable image');
        const size = img.getSize();
        return (size.width > width ? img.resize({ width, quality: 'best' }) : img).toPNG();
      },
      () => settings.get().exportWidth,
      pushStatus,
      log,
    );
    link = new SessionLink(
      c,
      sessionId,
      {
        onSpeakerCommand: (inv, p) => void core?.onSpeakerCommand(inv, p),
        onLaser: (inv, p) => core?.onLaser(inv, p),
        onPing: (inv, p) => core?.onPing(inv, p),
        onHello: () => core?.heartbeat(),
        onOperatorAction: (p) => void core?.onOperatorAction(p),
        onStatusChange: pushStatus,
      },
      log,
    );
    await link.start([]);
    await loadInvites(sessionId);

    const { data: ses } = await c.from('sessions').select('talk_length_sec').eq('id', sessionId).maybeSingle();
    if (ses?.talk_length_sec) core.setTalkLength(ses.talk_length_sec as number);

    await startShowControl();

    const pollMs = process.platform === 'darwin' ? 700 : 400;
    let lastChoose = 0;
    timers.push(
      setInterval(async () => {
        // Detecting which app is running costs extra osascript calls on macOS; do it every 3 s.
        if (Date.now() - lastChoose > 3000) {
          lastChoose = Date.now();
          current = await chooseAdapter(settings.get().appMode).catch(() => null);
        }
        await core?.poll();
        exporter?.tick(Boolean(core?.snapshot().inShow));
      }, pollMs),
      setInterval(() => core?.heartbeat(), 5000),
      setInterval(() => void loadInvites(sessionId), 60_000),
      setInterval(pushStatus, 1000),
    );
    log(`connected to ${s.session.name}`);
  } catch (e) {
    log(`connect failed: ${(e as Error).message}`);
  } finally {
    connecting = false;
    pushStatus();
  }
}

async function disconnect(): Promise<void> {
  timers.forEach(clearInterval);
  timers = [];
  showControl?.stop();
  showControl = null;
  await link?.stop();
  link = null;
  core = null;
  exporter = null;
}

async function startShowControl() {
  showControl?.stop();
  const s = settings.get();
  showControl = new ShowControl({
    httpPort: s.httpEnabled ? s.httpPort : null,
    oscPort: s.oscEnabled ? s.oscPort : null,
    lan: s.lan,
    token: s.token,
    run: async (action: OperatorAction, source: string) => {
      if (!core) throw new Error('Not connected');
      await core.onOperatorAction({ id: '', action }, source);
    },
    state: () => {
      const st = core?.snapshot();
      return st ? { app: st.app, inShow: st.inShow, pos: st.pos, slideCount: st.deck?.slideCount ?? null, blank: st.blank, locked: st.locked, timer: st.timer } : { connected: false };
    },
    log,
  });
  const ports = await showControl.start();
  core?.setShowControl({ httpPort: ports.httpPort, oscPort: ports.oscPort, lan: s.lan });
}

async function pair(code: string): Promise<{ ok: boolean; error?: string }> {
  const c = getClient();
  if (!c) return { ok: false, error: 'Enter the Supabase URL and key first' };
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) return { ok: false, error: 'The pairing code has 6 digits' };
  const { data: sess } = await c.auth.getSession();
  if (!sess.session) {
    const { error } = await c.auth.signInAnonymously();
    if (error) return { ok: false, error: `Sign-in failed: ${error.message}. Is anonymous sign-in enabled in Supabase?` };
  }
  const { data, error } = await c.rpc('pair_agent', { p_code: digits });
  if (error) return { ok: false, error: error.message };
  const row = (data as Array<{ session_id: string; session_name: string; room: string | null }> | null)?.[0];
  if (!row) return { ok: false, error: 'That code is not valid or has expired. Ask the operator for a new one.' };
  settings.update({ session: { id: row.session_id, name: row.session_name, room: row.room } });
  await connect();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main window and IPC
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function statusForUi() {
  const s = settings.get();
  const st = core?.snapshot() ?? null;
  return {
    platform: process.platform,
    configured: Boolean(s.supabaseUrl && s.anonKey),
    supabaseUrl: s.supabaseUrl,
    session: s.session,
    link: link?.linkStatus() ?? (s.session ? 'connecting' : 'idle'),
    state: st,
    speakerName: st?.controller ? invites.get(st.controller) ?? 'Speaker' : null,
    appError: core?.lastAppError() ?? null,
    export: exporter?.status() ?? null,
    settings: { ...s, anonKey: s.anonKey ? '••••' : '' },
    accessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    log: logLines.slice(-40),
  };
}

function pushStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', statusForUi());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    title: 'Slide Relay Agent',
    backgroundColor: '#0B0C0E',
    webPreferences: { preload: join(distDir, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  void mainWindow.loadFile(join(uiDir, 'index.html'));
  // The hidden overlay window would otherwise keep the app alive after the main window closes.
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
  // Developer aid for CI smoke tests: RSC_SMOKE_SCREENSHOT=/path/out.png captures the window and quits.
  const shot = process.env.RSC_SMOKE_SCREENSHOT;
  if (shot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await mainWindow!.webContents.capturePage();
        await writeFile(shot, img.toPNG());
        app.exit(0);
      }, 1500);
    });
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.handle('status', () => statusForUi());
ipcMain.handle('configure', async (_e, cfg: { supabaseUrl: string; anonKey: string }) => {
  const url = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  const key = String(cfg.anonKey || '').trim();
  if (!/^https:\/\/.+/.test(url)) return { ok: false, error: 'The Supabase URL starts with https://' };
  if (key.length < 20) return { ok: false, error: 'Paste the anon / publishable key from Supabase → Settings → API' };
  await disconnect();
  client = null;
  authStore.clear();
  settings.update({ supabaseUrl: url, anonKey: key, session: null });
  pushStatus();
  return { ok: true };
});
ipcMain.handle('pair', (_e, code: string) => pair(String(code)));
ipcMain.handle('unpair', async () => {
  await disconnect();
  settings.update({ session: null });
  await getClient()?.auth.signOut();
  pushStatus();
  return { ok: true };
});
ipcMain.handle('settings', async (_e, patch: Partial<Settings>) => {
  const allowed: Partial<Settings> = {};
  if (patch.appMode && ['auto', 'powerpoint', 'keynote', 'keys'].includes(patch.appMode)) allowed.appMode = patch.appMode;
  if (patch.overlayDisplayId === null || typeof patch.overlayDisplayId === 'number') allowed.overlayDisplayId = patch.overlayDisplayId;
  if (typeof patch.httpEnabled === 'boolean') allowed.httpEnabled = patch.httpEnabled;
  if (typeof patch.oscEnabled === 'boolean') allowed.oscEnabled = patch.oscEnabled;
  if (typeof patch.lan === 'boolean') allowed.lan = patch.lan;
  if (Number.isInteger(patch.httpPort) && patch.httpPort! > 1023 && patch.httpPort! < 65536) allowed.httpPort = patch.httpPort;
  if (Number.isInteger(patch.oscPort) && patch.oscPort! > 1023 && patch.oscPort! < 65536) allowed.oscPort = patch.oscPort;
  if (Number.isInteger(patch.exportWidth) && patch.exportWidth! >= 640 && patch.exportWidth! <= 3840) allowed.exportWidth = patch.exportWidth;
  settings.update(allowed);
  if (allowed.appMode) current = await chooseAdapter(allowed.appMode);
  if ('httpEnabled' in allowed || 'oscEnabled' in allowed || 'lan' in allowed || 'httpPort' in allowed || 'oscPort' in allowed) await startShowControl();
  if ('overlayDisplayId' in allowed) {
    overlay?.destroy();
    overlay = null;
  }
  pushStatus();
  return { ok: true };
});
ipcMain.handle('displays', () => {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || `Display ${i + 1}`} · ${d.size.width}×${d.size.height}${d.id === primary.id ? ' (main)' : ''}`,
  }));
});
ipcMain.handle('resync', async () => {
  await core?.onOperatorAction({ id: '', action: { type: 'resync' } }, 'Agent');
  return { ok: true };
});
ipcMain.handle('test-laser', () => {
  const style = core?.snapshot().laser ?? { color: '#FF4D4D', size: 'M' as const };
  const aspect = core?.snapshot().deck?.aspect ?? 16 / 9;
  let t = 0;
  const id = setInterval(() => {
    t += 1;
    drawLaser({ x: 0.5 + 0.35 * Math.cos(t / 8), y: 0.5 + 0.35 * Math.sin(t / 8) }, style, aspect);
    if (t > 100) {
      clearInterval(id);
      drawLaser(null, style, aspect);
    }
  }, 30);
  return { ok: true };
});
ipcMain.handle('keys-reset', (_e, cfg: { slide?: number; slideCount?: number }) => {
  const k = keysAdapter();
  k.resetPosition(Number(cfg?.slide) || 1);
  if (Number.isInteger(cfg?.slideCount)) k.setSlideCount(Number(cfg.slideCount));
  void core?.poll();
  return { ok: true };
});
ipcMain.handle('ask-accessibility', () => {
  if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
  return { ok: true };
});
ipcMain.handle('decks', async () => {
  const c = getClient();
  const s = settings.get();
  if (!c || !s.session) return [];
  const { data } = await c
    .from('decks')
    .select('id, file_name, status, storage_path, created_at, invites(display_name)')
    .eq('session_id', s.session.id)
    .eq('source', 'upload')
    .order('created_at', { ascending: false });
  return ((data ?? []) as unknown as Array<{ id: string; file_name: string; status: string; storage_path: string | null; created_at: string; invites: { display_name: string } | null }>).map((d) => ({
    id: d.id,
    fileName: d.file_name,
    status: d.status,
    speaker: d.invites?.display_name ?? 'Speaker',
    hasFile: Boolean(d.storage_path),
  }));
});
ipcMain.handle('open-deck', async (_e, deckId: string) => {
  const c = getClient();
  const s = settings.get();
  if (!c || !s.session) return { ok: false, error: 'Not connected' };
  const { data: deck } = await c.from('decks').select('file_name, storage_path').eq('id', deckId).maybeSingle();
  if (!deck?.storage_path) return { ok: false, error: 'File not found' };
  const { data: signed, error } = await c.storage.from('decks').createSignedUrl(deck.storage_path as string, 120);
  if (error || !signed) return { ok: false, error: error?.message ?? 'Could not get the file' };
  const res = await fetch(signed.signedUrl);
  if (!res.ok) return { ok: false, error: `Download failed (${res.status})` };
  const folder = join(app.getPath('documents'), 'Slide Relay', safeName(s.session.name));
  await mkdir(folder, { recursive: true });
  let target = join(folder, safeName(deck.file_name as string));
  if (existsSync(target)) target = target.replace(/(\.[^.]+)?$/, (ext) => ` (${new Date().toISOString().slice(11, 19).replace(/:/g, '')})${ext}`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  const openErr = await shell.openPath(target);
  log(`downloaded ${deck.file_name} → ${target}`);
  return openErr ? { ok: false, error: openErr } : { ok: true, path: target };
});

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'deck';
}

app.whenReady().then(async () => {
  createMainWindow();
  current = await chooseAdapter(settings.get().appMode).catch(() => null);
  if (settings.get().session) await connect();
  screen.on('display-removed', () => {
    overlay?.destroy();
    overlay = null;
  });
  screen.on('display-added', pushStatus);
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void (async () => {
    await disconnect().catch(() => undefined);
    winPpt?.dispose();
    winPptExport?.dispose();
    overlay?.destroy();
    app.quit();
  })();
});

app.on('window-all-closed', () => app.quit());
