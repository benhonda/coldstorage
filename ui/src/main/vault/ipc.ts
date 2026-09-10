/**
 * The vault slice of the main↔renderer seam: status get + push, plus the user actions (retry the
 * handoff now, submit a recovery code, acknowledge the one-time code). Mirrors auth/ipc.ts.
 */
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type { VaultManager } from "./manager.ts";

export const registerVaultIpc = (vault: VaultManager, retry: () => Promise<void>): (() => void) => {
  ipcMain.handle(IPC.vaultStatus, () => vault.vaultStatus());
  ipcMain.handle(IPC.vaultRetry, () => retry());
  ipcMain.handle(IPC.vaultSubmitRecoveryCode, (_e, code: string) => vault.submitRecoveryCode(code));
  ipcMain.handle(IPC.vaultAckRecoveryCode, () => vault.acknowledgeRecoveryCode());
  ipcMain.handle(IPC.vaultReissueRecoveryCode, () => vault.reissueRecoveryCode());

  const offStatus = vault.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.vaultStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.vaultStatus);
    ipcMain.removeHandler(IPC.vaultRetry);
    ipcMain.removeHandler(IPC.vaultSubmitRecoveryCode);
    ipcMain.removeHandler(IPC.vaultAckRecoveryCode);
    ipcMain.removeHandler(IPC.vaultReissueRecoveryCode);
    offStatus();
  };
};
