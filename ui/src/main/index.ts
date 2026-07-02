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
 * Sign-in (PROD.md Phase 5): main also owns the {@link AuthManager} — the OAuth flow, tokens, and
 * the daemon handoff (each fresh ID token → the daemon's `authenticate` command, which swaps its S3
 * credentials to the signed-in user so uploads land under `blobs/<identityId>/`). The redirect
 * arrives as a `coldstorage://auth/callback` deep link (packaged; scheme registered via
 * electron-builder `protocols`) or on the dev loopback listener (see auth/loopback.ts).
 *
 * ESM main (package.json `type: module`): use `import.meta.dirname`, not `__dirname`.
 */
import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { DaemonClient } from "../daemon/client.ts";
import { registerBridge } from "./bridge.ts";
import { registerSystemHandlers } from "./system.ts";
import { startDaemon, daemonSocketPath } from "./daemon.ts";
import { AuthManager } from "./auth/manager.ts";
import { resolveOAuthConfig } from "./auth/config.ts";
import { registerAuthIpc } from "./auth/ipc.ts";
import { VaultManager } from "./vault/manager.ts";
import { VaultStore } from "./vault/storage.ts";
import { KeyBlobClient } from "./vault/keyblob-client.ts";
import { resolveAccountApiBaseUrl } from "./vault/config.ts";
import { registerVaultIpc } from "./vault/ipc.ts";

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

// Sign-in state machine. Null config = dogfood mode: status reports unconfigured, the renderer hides
// auth entirely, and none of the wiring below ever fires. Dev uses the loopback redirect (an unpackaged
// Electron can't receive custom-scheme deep links on macOS).
const auth = new AuthManager(resolveOAuthConfig(), { useLoopback: !app.isPackaged });
const disposeAuthIpc = registerAuthIpc(auth);

// The zero-knowledge vault (encryption-key half of being signed in). Escrows the MasterKey per-account
// in userData/vault.json (safeStorage), fetches/stores the key-blob at the account backend, and drives
// the daemon's mint/unlock/lock commands. Only ever exercised in multi-user mode (its provision runs
// after a successful `authenticate`, which only happens when sign-in is configured).
const vault = new VaultManager(
  client,
  new VaultStore(join(app.getPath("userData"), "vault.json")),
  new KeyBlobClient(resolveAccountApiBaseUrl()),
);
const disposeVaultIpc = registerVaultIpc(vault);

// ── Deep links (macOS delivers them as open-url, launch AND while running). Registered before
//    `ready` because a URL can be what LAUNCHES the app — those arrive pre-ready and are buffered.
//    (The scheme itself comes from Info.plist CFBundleURLTypes — electron-builder `protocols` — so
//    this is packaged-only in practice; setAsDefaultProtocolClient just claims default-handler.) ──
let pendingDeepLink: string | null = null;
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) void auth.handleCallbackUrl(url);
  else pendingDeepLink = url;
});
if (app.isPackaged) app.setAsDefaultProtocolClient("coldstorage");

// Single-instance hygiene. macOS Launch Services already routes protocol URLs to the running instance
// (as open-url), but the lock guards CLI double-launches — and on Win/Linux (if we ever ship there)
// protocol URLs arrive via second-instance argv instead, so the shape is already right.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((a) => a.startsWith("coldstorage://"));
    if (url) void auth.handleCallbackUrl(url);
    focusMainWindow();
  });
}

const focusMainWindow = (): void => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
};

// ── Daemon handoff: provision the daemon for the signed-in user — `authenticate` (per-user AWS creds)
//    THEN vault `provision` (the encryption key). Both are needed before a deposit works, so they run in
//    sequence. Fires on every fresh ID token (sign-in + hourly refresh) and on daemon (re)connect, since
//    a freshly-connected daemon starts unauthenticated AND locked. Failures are logged, not fatal — a
//    dogfood daemon rejects `authenticate` and provision never proceeds. ──
const provisionDaemon = async (idToken: string): Promise<void> => {
  await client.request("authenticate", { idToken });
  await vault.provision(idToken);
};
// A failure here that ISN'T just "the daemon isn't connected yet" (which the reconnect handler below
// retries) means authenticate itself failed — surface it in the vault status so the UI shows a real
// error instead of hanging on "Setting up…" forever.
const onProvisionFailure = (e: unknown): void => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("daemon provision failed:", e);
  if (!msg.includes("not connected")) vault.markProvisionError(msg);
};
const offIdToken = auth.onIdToken((idToken) => {
  void provisionDaemon(idToken).catch(onProvisionFailure);
});
const offClientConnect = client.on("connect", () => {
  void auth
    .getFreshIdToken()
    .then((idToken) => (idToken ? provisionDaemon(idToken) : null))
    .catch(onProvisionFailure);
});

// Bring the window back when a sign-in completes — the user is off in the browser; the deep link
// should land them back in the app, signed in. And when sign-out happens, tell the vault to relock the
// daemon (drop the MasterKey). (Focus only on signingIn→signedIn, not background refreshes.)
let prevAuthState = auth.status().state;
const offAuthFocus = auth.onStatus((s) => {
  if (prevAuthState === "signingIn" && s.state === "signedIn") focusMainWindow();
  if (prevAuthState !== "signedOut" && s.state === "signedOut") void vault.relock();
  prevAuthState = s.state;
});

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

  // Silent session restore (safeStorage needs `ready` for the Keychain), then any deep link that
  // LAUNCHED the app. Both async; the renderer just sees status pushes whenever they land.
  void auth.restore().then(() => {
    if (pendingDeepLink) {
      void auth.handleCallbackUrl(pendingDeepLink);
      pendingDeepLink = null;
    }
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
  disposeAuthIpc();
  disposeVaultIpc();
  offIdToken();
  offClientConnect();
  offAuthFocus();
  auth.dispose();
  vault.dispose();
  client.close();
  stopDaemon(); // terminate the supervised child (no-op in dev)
});
