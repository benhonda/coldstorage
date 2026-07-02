/**
 * The auth slice of the main↔renderer seam: invoke handlers for signIn/signOut/status + the status
 * push to every window. Same shape as bridge.ts (the daemon slice) — the renderer only ever sees
 * {@link AuthStatus}, never a token.
 */
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type { AuthManager } from "./manager.ts";

/** Register the auth IPC surface. Returns a disposer (symmetry with registerBridge). */
export const registerAuthIpc = (auth: AuthManager): (() => void) => {
  ipcMain.handle(IPC.authStatus, () => auth.status());
  ipcMain.handle(IPC.authSignIn, () => auth.signIn());
  ipcMain.handle(IPC.authSignOut, () => auth.signOut());

  const offStatus = auth.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.authStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.authStatus);
    ipcMain.removeHandler(IPC.authSignIn);
    ipcMain.removeHandler(IPC.authSignOut);
    offStatus();
  };
};
