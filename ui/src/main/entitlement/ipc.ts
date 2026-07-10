/** The entitlement slice of the main↔renderer seam (PROD.md Phase 5c). Mirrors auth/vault ipc. */
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type { EntitlementManager } from "./manager.ts";

export const registerEntitlementIpc = (entitlement: EntitlementManager): (() => void) => {
  ipcMain.handle(IPC.entitlementStatus, () => entitlement.entitlementStatus());
  ipcMain.handle(IPC.entitlementCatalog, () => entitlement.getCatalog());
  ipcMain.handle(IPC.entitlementSubscribe, (_e, priceId: string) => entitlement.subscribe(priceId));

  const offStatus = entitlement.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.entitlementStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.entitlementStatus);
    ipcMain.removeHandler(IPC.entitlementCatalog);
    ipcMain.removeHandler(IPC.entitlementSubscribe);
    offStatus();
  };
};
