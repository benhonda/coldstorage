/**
 * The vault slice of the main↔renderer seam (PROD.md Phase 5b): status get + push, plus the two user
 * actions (submit a recovery code, acknowledge the one-time code). Mirrors auth/ipc.ts.
 */
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type { VaultManager } from "./manager.ts";

export const registerVaultIpc = (vault: VaultManager): (() => void) => {
  ipcMain.handle(IPC.vaultStatus, () => vault.vaultStatus());
  ipcMain.handle(IPC.vaultSubmitRecoveryCode, (_e, code: string) => vault.submitRecoveryCode(code));
  ipcMain.handle(IPC.vaultAckRecoveryCode, () => vault.acknowledgeRecoveryCode());

  const offStatus = vault.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.vaultStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.vaultStatus);
    ipcMain.removeHandler(IPC.vaultSubmitRecoveryCode);
    ipcMain.removeHandler(IPC.vaultAckRecoveryCode);
    offStatus();
  };
};
