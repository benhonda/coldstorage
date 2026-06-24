/**
 * Main-process OS integrations the renderer needs but can't reach (no Node in the renderer): the native
 * folder picker and the default Downloads directory, used by the request-a-copy dialog. Kept separate
 * from {@link registerBridge} (which is strictly the daemon-client seam).
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { IPC } from "../shared/ipc.ts";

/** Register the dialog/path handlers. Returns a disposer that removes them. */
export const registerSystemHandlers = (): (() => void) => {
  ipcMain.handle(IPC.downloadsDir, () => app.getPath("downloads"));

  ipcMain.handle(IPC.chooseFolder, async (_e, defaultPath?: string) => {
    const opts: Electron.OpenDialogOptions = {
      title: "Choose a folder",
      defaultPath: defaultPath || app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    };
    // Parent to the focused window so it's a sheet on macOS (modal, attached), not a free window.
    const win = BrowserWindow.getFocusedWindow();
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  return () => {
    ipcMain.removeHandler(IPC.downloadsDir);
    ipcMain.removeHandler(IPC.chooseFolder);
  };
};
