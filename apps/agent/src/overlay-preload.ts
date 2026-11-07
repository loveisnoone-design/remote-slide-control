import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('rscOverlay', {
  onLaser: (cb: (msg: unknown) => void) => {
    ipcRenderer.on('laser', (_e, msg) => cb(msg));
  },
});
