/** The auto-update slice of the main↔renderer seam (PROD.md Phase 6). Mirrors entitlement/auth/vault ipc. */
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type { UpdateManager } from "./manager.ts";

export const registerUpdateIpc = (updater: UpdateManager): (() => void) => {
  ipcMain.handle(IPC.updateStatus, () => updater.status());
  ipcMain.handle(IPC.updateCheck, () => updater.check());
  ipcMain.handle(IPC.updateRestart, () => updater.restart());

  const offStatus = updater.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.updateStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.updateStatus);
    ipcMain.removeHandler(IPC.updateCheck);
    ipcMain.removeHandler(IPC.updateRestart);
    offStatus();
  };
};
