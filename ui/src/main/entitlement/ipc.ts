/** The entitlement slice of the main↔renderer seam (PROD.md Phase 5c). Mirrors auth/vault ipc. */
import { BrowserWindow, ipcMain } from "electron";
import { IPC, type ManagePage } from "../../shared/ipc.ts";
import type { EntitlementManager } from "./manager.ts";

export const registerEntitlementIpc = (entitlement: EntitlementManager): (() => void) => {
  ipcMain.handle(IPC.entitlementStatus, () => entitlement.entitlementStatus());
  ipcMain.handle(IPC.entitlementCatalog, () => entitlement.getCatalog());
  ipcMain.handle(IPC.entitlementSubscribe, (_e, priceId: string) => entitlement.subscribe(priceId));
  ipcMain.handle(IPC.entitlementSubscription, () => entitlement.getSubscription());
  ipcMain.handle(IPC.entitlementPreviewChange, (_e, priceId: string) => entitlement.previewPlanChange(priceId));
  ipcMain.handle(IPC.entitlementChangePlan, (_e, priceId: string) => entitlement.changePlan(priceId));
  ipcMain.handle(IPC.entitlementOpenManage, (_e, page: ManagePage) => entitlement.openManage(page));

  const offStatus = entitlement.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.entitlementStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.entitlementStatus);
    ipcMain.removeHandler(IPC.entitlementCatalog);
    ipcMain.removeHandler(IPC.entitlementSubscribe);
    ipcMain.removeHandler(IPC.entitlementSubscription);
    ipcMain.removeHandler(IPC.entitlementPreviewChange);
    ipcMain.removeHandler(IPC.entitlementChangePlan);
    ipcMain.removeHandler(IPC.entitlementOpenManage);
    offStatus();
  };
};
