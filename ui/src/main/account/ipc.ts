/** The account slice of the main↔renderer seam (onboarding wizard + Settings name). Mirrors entitlement/ipc.ts. */
import { BrowserWindow, ipcMain } from "electron";
import { IPC, type SurveyAnswers } from "../../shared/ipc.ts";
import type { AccountManager } from "./manager.ts";

export const registerAccountIpc = (account: AccountManager): (() => void) => {
  ipcMain.handle(IPC.accountStatus, () => account.accountStatus());
  ipcMain.handle(IPC.accountSetDisplayName, (_e, name: string) => account.setDisplayName(name));
  ipcMain.handle(IPC.accountSubmitSurvey, (_e, answers: SurveyAnswers) => account.submitSurvey(answers));
  ipcMain.handle(IPC.accountCompleteOnboarding, () => account.completeOnboarding());
  ipcMain.handle(IPC.accountConfirmRecoveryCode, () => account.confirmRecoveryCode());

  const offStatus = account.onStatus((s) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.accountStatusChanged, s);
  });

  return () => {
    ipcMain.removeHandler(IPC.accountStatus);
    ipcMain.removeHandler(IPC.accountSetDisplayName);
    ipcMain.removeHandler(IPC.accountSubmitSurvey);
    ipcMain.removeHandler(IPC.accountCompleteOnboarding);
    ipcMain.removeHandler(IPC.accountConfirmRecoveryCode);
    offStatus();
  };
};
