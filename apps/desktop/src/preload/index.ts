import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DaemonStatus, type TandemiseBridge } from '../shared/bridge.js';

/**
 * The only bridge between the sandboxed renderer and the OS.
 *
 * Every member forwards to a main-process handler that validates its own
 * arguments; nothing here hands the renderer a raw `ipcRenderer`, a module
 * loader, or a path, because any of those would make `contextIsolation`
 * decorative (MVP.md §32).
 */
const bridge: TandemiseBridge = {
  platform: process.platform,
  getDaemonStatus: () => ipcRenderer.invoke(IPC.daemonStatus),
  reconnectDaemon: () => ipcRenderer.invoke(IPC.daemonReconnect),
  onDaemonStatus(listener) {
    const handler = (_event: unknown, status: DaemonStatus): void => listener(status);
    ipcRenderer.on(IPC.daemonStatusChanged, handler);
    return () => {
      ipcRenderer.off(IPC.daemonStatusChanged, handler);
    };
  },
  selectDirectory: (title) => ipcRenderer.invoke(IPC.selectDirectory, title),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  revealInFinder: (path) => ipcRenderer.invoke(IPC.revealInFinder, path),
};

contextBridge.exposeInMainWorld('tandemise', bridge);
