/**
 * Electron main process (layer 2). Owns the single long-lived {@link DaemonClient} (the only thing
 * that touches the unix socket), creates the window, and wires the IPC bridge. The renderer is pure
 * UI talking to `window.coldstore`; it never sees Node, the socket, or `ipcRenderer`.
 *
 * Security posture: `contextIsolation: true` + `nodeIntegration: false` — the renderer can't reach
 * Node. `sandbox: false` is the electron-vite default (its ESM preload requires it); the meaningful
 * boundary here is contextIsolation, and we load only local bundled content (no remote URLs).
 * Hardening to `sandbox: true` (needs a CJS preload build) is a documented follow-up.
 *
 * ESM main (package.json `type: module`): use `import.meta.dirname`, not `__dirname`.
 */
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { DaemonClient } from "../daemon/client.ts";
import { registerBridge } from "./bridge.ts";
import { registerSystemHandlers } from "./system.ts";

const client = new DaemonClient(); // autoReconnect on by default — survives launchd KeepAlive restarts
const disposeBridge = registerBridge(client);
const disposeSystem = registerSystemHandlers();

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    title: "ColdStorage",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Open external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // electron-vite serves the renderer over HTTP in dev (HMR) and from disk in prod.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
};

app.whenReady().then(() => {
  // Dial the daemon. If it's down, autoReconnect keeps retrying; the renderer shows "disconnected"
  // until a 'connect' lifecycle push arrives. First dial failing is expected and non-fatal.
  client.connect().catch(() => {
    /* lifecycle/reconnect handles it */
  });

  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS apps typically stay alive when all windows close; we follow the platform convention.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  disposeBridge();
  disposeSystem();
  client.close();
});
