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
import { startDaemon, daemonSocketPath } from "./daemon.ts";

// Pin the app name BEFORE any `getPath("userData")` call. The client resolves the socket path at module
// load and the daemon supervisor resolves it in `whenReady`; both derive from userData (= appData + app
// name). If the name weren't settled identically at both moments the two paths could diverge and never
// meet (→ stuck "connecting"). Pinning it to the productName makes userData deterministic from the start.
app.setName("ColdStorage");

// Packaged: the app OWNS its daemon (spawned as a child → app's TCC identity, see daemon.ts), so dial the
// per-user socket it creates. Dev: the daemon runs standalone (`task daemon:run`); use the env/default path.
const client = new DaemonClient(app.isPackaged ? { socketPath: daemonSocketPath() } : undefined);
const disposeBridge = registerBridge(client);
const disposeSystem = registerSystemHandlers();
let stopDaemon: () => void = () => {};

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
  // Packaged: bring up our own daemon first (the child whose socket the client dials), and start at login
  // so backups resume after a reboot — the menu-bar/background model a backup app follows. (TODO: expose
  // openAtLogin as a Settings toggle; pair the background-run UX with a Tray + LSUIElement — see PACKAGING.md.)
  if (app.isPackaged) {
    stopDaemon = startDaemon();
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // Dial the daemon. If it's not up yet (the child is still binding its socket), autoReconnect keeps
  // retrying; the renderer shows "connecting" until a 'connect' lifecycle push arrives. Non-fatal.
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
  stopDaemon(); // terminate the supervised child (no-op in dev)
});
