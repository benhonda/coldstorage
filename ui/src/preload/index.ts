/**
 * Preload (layer 2). Runs in an isolated world with access to `ipcRenderer`, and exposes ONLY the
 * narrow {@link ColdstoreApi} on `window.coldstore` via `contextBridge`. The renderer never sees
 * `ipcRenderer` itself — it can only do what this surface allows.
 *
 * The casts here are the unavoidable IPC-boundary seam: invoke/event payloads are `unknown` over the
 * wire, re-typed against the contract exactly once, right here.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { IPC, type ColdstoreApi } from "../shared/ipc.ts";

const api: ColdstoreApi = {
  request: ((method: string, params?: Record<string, string>) =>
    ipcRenderer.invoke(IPC.request, method, params)) as ColdstoreApi["request"],

  getConnectionState: () => ipcRenderer.invoke(IPC.connectionState),

  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, name: unknown, data: unknown): void =>
      (listener as (n: unknown, d: unknown) => void)(name, data);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.removeListener(IPC.event, handler);
  },

  onLifecycle: (listener) => {
    const handler = (_e: IpcRendererEvent, state: unknown): void =>
      (listener as (s: unknown) => void)(state);
    ipcRenderer.on(IPC.lifecycle, handler);
    return () => ipcRenderer.removeListener(IPC.lifecycle, handler);
  },

  chooseFolder: (defaultPath?: string) => ipcRenderer.invoke(IPC.chooseFolder, defaultPath),
  getDownloadsDir: () => ipcRenderer.invoke(IPC.downloadsDir),
  pickPhotos: () => ipcRenderer.invoke(IPC.pickPhotos),
  openPhotosSettings: () => ipcRenderer.invoke(IPC.openPhotosSettings),

  getAuthStatus: () => ipcRenderer.invoke(IPC.authStatus),
  signIn: () => ipcRenderer.invoke(IPC.authSignIn),
  signOut: () => ipcRenderer.invoke(IPC.authSignOut),
  onAuthStatus: (listener) => {
    const handler = (_e: IpcRendererEvent, status: unknown): void =>
      (listener as (s: unknown) => void)(status);
    ipcRenderer.on(IPC.authStatusChanged, handler);
    return () => ipcRenderer.removeListener(IPC.authStatusChanged, handler);
  },

  getVaultStatus: () => ipcRenderer.invoke(IPC.vaultStatus),
  submitRecoveryCode: (code: string) => ipcRenderer.invoke(IPC.vaultSubmitRecoveryCode, code),
  acknowledgeRecoveryCode: () => ipcRenderer.invoke(IPC.vaultAckRecoveryCode),
  onVaultStatus: (listener) => {
    const handler = (_e: IpcRendererEvent, status: unknown): void =>
      (listener as (s: unknown) => void)(status);
    ipcRenderer.on(IPC.vaultStatusChanged, handler);
    return () => ipcRenderer.removeListener(IPC.vaultStatusChanged, handler);
  },
  // Resolve a dropped/picked File → absolute path here in the preload (webUtils isn't in the renderer).
  pathForFile: (file: File) => webUtils.getPathForFile(file),
};

// contextIsolation is always on (set in main); the else is a defensive no-op path, not a supported mode.
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("coldstore", api);
} else {
  (globalThis as unknown as { coldstore: ColdstoreApi }).coldstore = api;
}
