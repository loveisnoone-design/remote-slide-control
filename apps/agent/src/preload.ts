import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rsc', {
  status: () => ipcRenderer.invoke('status'),
  onStatus: (cb: (s: unknown) => void) => {
    const l = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('status', l);
    return () => ipcRenderer.removeListener('status', l);
  },
  configure: (cfg: { supabaseUrl: string; anonKey: string }) => ipcRenderer.invoke('configure', cfg),
  pair: (code: string) => ipcRenderer.invoke('pair', code),
  unpair: () => ipcRenderer.invoke('unpair'),
  settings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings', patch),
  displays: () => ipcRenderer.invoke('displays'),
  resync: () => ipcRenderer.invoke('resync'),
  testLaser: () => ipcRenderer.invoke('test-laser'),
  keysReset: (cfg: { slide?: number; slideCount?: number }) => ipcRenderer.invoke('keys-reset', cfg),
  askAccessibility: () => ipcRenderer.invoke('ask-accessibility'),
  decks: () => ipcRenderer.invoke('decks'),
  openDeck: (id: string) => ipcRenderer.invoke('open-deck', id),
});
