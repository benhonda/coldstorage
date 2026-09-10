/**
 * The application menu — and with it, the one update affordance that exists on EVERY screen. The
 * renderer's "Check for updates" lives at the foot of Settings, and its "Restart to update" banner only
 * appears once a build is downloaded; neither is reachable from the sign-in and vault gates, or while a
 * modal is up. The platform answer is the same one every Mac app gives: **coldstorage ▸ Check for
 * Updates…**, owned by main, independent of what the renderer is showing.
 *
 * The item is the updater's status, phrased as a verb: it reads "Restart to Update" once a build is
 * `ready`, goes inert while a check/download is in flight, and is disabled outright where a check cannot
 * succeed — a dev build, or an install macOS will refuse to update (the same two facts the Settings
 * footer consults, `AppInfo.packaged` + `AppInfo.signature`). The menu is rebuilt on every status push,
 * which is what keeps the label honest; `Menu.setApplicationMenu` is cheap.
 *
 * A menu-started check answers in a native dialog, in the SAME sentence the Settings footer would show
 * (`shared/updateLine.ts`) — one wording, two doors (PILLAR3, PILLAR5). Background/periodic checks stay
 * silent as before; only the check the user asked for gets to speak.
 */
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import type { UpdateStatus } from "../shared/ipc.ts";
import { updateLine } from "../shared/updateLine.ts";
import type { UpdateManager } from "./updater/manager.ts";
import { codeSignature } from "./updater/signature.ts";

const isMac = process.platform === "darwin";

/** What the user sees after pressing "Check for Updates…" — the shared sentence, plus the one line a
 * dialog needs that a footer doesn't: what happens next, since the dialog is about to go away. */
const showResult = async (status: UpdateStatus, packaged: boolean, updater: UpdateManager): Promise<void> => {
  const line = updateLine(status, { packaged, signature: await codeSignature() }, Date.now());
  const base = { type: line.tone === "bad" ? ("warning" as const) : ("info" as const), message: line.text };
  // Sheet on the app window when there is one; a free-standing dialog otherwise (all windows closed —
  // the app stays alive in the dock on macOS, and the menu is still there).
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const show = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  if (status.state === "ready") {
    const { response } = await show({ ...base, buttons: ["Restart to Update", "Later"], defaultId: 0, cancelId: 1 });
    if (response === 0) updater.restart();
    return;
  }
  const detail =
    status.state === "available" || status.state === "downloading"
      ? "It downloads in the background. You'll be offered a restart when it's ready, and it installs on the next quit either way."
      : undefined;
  await show({ ...base, ...(detail ? { detail } : {}) });
};

/** The update item for the current status. Never absent — an app menu with the item missing on some
 * launches and present on others is worse than a disabled one that says why in Settings. */
const updateItem = (status: UpdateStatus, canUpdate: boolean, updater: UpdateManager): MenuItemConstructorOptions => {
  switch (status.state) {
    case "ready":
      return { label: "Restart to Update", enabled: canUpdate, click: () => updater.restart() };
    case "checking":
      return { label: "Checking for Updates…", enabled: false };
    case "available":
    case "downloading":
      return { label: status.percent == null ? "Downloading Update…" : `Downloading Update… ${status.percent}%`, enabled: false };
    case "idle":
    case "error":
      return {
        label: "Check for Updates…",
        enabled: canUpdate,
        click: () => void updater.checkNow().then((s) => showResult(s, app.isPackaged, updater)),
      };
  }
};

const template = (status: UpdateStatus, canUpdate: boolean, updater: UpdateManager): MenuItemConstructorOptions[] => {
  const update = updateItem(status, canUpdate, updater);
  return [
    // macOS: the item sits under the app-named menu, where Sparkle apps (and Apple's) put it.
    ...(isMac
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              update,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : [{ label: "File", submenu: [{ role: "quit" as const }] }]),
    // The stock roles the default menu gave us — copy/paste in inputs, zoom, minimize — kept verbatim.
    { role: "editMenu" as const },
    { role: "viewMenu" as const },
    { role: "windowMenu" as const },
    // Elsewhere, Help is the conventional home for the update item.
    ...(isMac ? [] : [{ role: "help" as const, submenu: [update] }]),
  ];
};

/**
 * Install the menu and keep it in step with the updater. Call after `app.whenReady()`. Returns a disposer
 * (drops the status subscription; the menu itself stays until quit).
 */
export const installAppMenu = (updater: UpdateManager): (() => void) => {
  let canUpdate = false;
  const apply = (status: UpdateStatus): void => Menu.setApplicationMenu(Menu.buildFromTemplate(template(status, canUpdate, updater)));
  // First paint with the item disabled, then flip it once the (memoized) codesign read answers — a
  // menu that appears a beat late is worse than one whose item enables a beat late.
  apply(updater.status());
  void codeSignature().then((sig) => {
    canUpdate = app.isPackaged && sig !== "other";
    apply(updater.status());
  });
  return updater.onStatus(apply);
};
