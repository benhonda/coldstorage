/**
 * Main-process OS integrations the renderer needs but can't reach (no Node in the renderer): the native
 * folder picker, the default Downloads directory (request-a-copy dialog), and the native Photos picker
 * (the explicit photo-deposit path, UI option B). Kept separate from {@link registerBridge} (which is
 * strictly the daemon-client seam).
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC, type PhotoPick } from "../shared/ipc.ts";

/** Deep-link straight to System Settings ▸ Privacy & Security ▸ Photos (macOS). The recovery path the
 * toast offers when a photo deposit failed for lack of (full) Photos access — `tccutil`/relaunch can't
 * re-prompt a denied grant, so the user flips it here. */
const PHOTOS_PRIVACY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos";

/** Resolve the native Photos-picker helper binary. Precedence: explicit `$COLDSTORE_PHOTO_PICKER` (set by
 * the Taskfile for ui:dev/ui:live) → the bundled copy under `Contents/Resources/bin` in a packaged app
 * (see electron-builder.yml extraResources) → the dev `.build/release` path. */
const photoPickerPath = (): string =>
  process.env.COLDSTORE_PHOTO_PICKER ??
  (app.isPackaged
    ? join(process.resourcesPath, "bin", "coldstore-photo-picker")
    : "coldstorage/.build/release/coldstore-photo-picker");

const isPhotoPick = (x: unknown): x is PhotoPick =>
  typeof x === "object" && x !== null && typeof (x as PhotoPick).id === "string" && typeof (x as PhotoPick).name === "string";

/** Spawn the picker helper and parse its stdout (a JSON array of {id, name}). The helper prints `[]` on
 * cancel/empty (exit 0); a non-zero exit (e.g. run off a Mac, or a missing binary) rejects so the renderer
 * can surface it. The shape is validated so a malformed line can't reach the daemon as a bogus payload. */
const pickPhotos = (): Promise<PhotoPick[]> =>
  new Promise((resolve, reject) => {
    execFile(photoPickerPath(), { timeout: 5 * 60_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const parsed: unknown = JSON.parse(stdout.trim() || "[]");
        if (!Array.isArray(parsed) || !parsed.every(isPhotoPick)) {
          return reject(new Error("photo picker returned an unexpected payload"));
        }
        resolve(parsed);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });

/** Register the dialog/path handlers. Returns a disposer that removes them. */
export const registerSystemHandlers = (): (() => void) => {
  ipcMain.handle(IPC.downloadsDir, () => app.getPath("downloads"));
  ipcMain.handle(IPC.pickPhotos, () => pickPhotos());
  ipcMain.handle(IPC.openPhotosSettings, () => shell.openExternal(PHOTOS_PRIVACY_PANE));

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
    ipcMain.removeHandler(IPC.pickPhotos);
    ipcMain.removeHandler(IPC.openPhotosSettings);
  };
};
