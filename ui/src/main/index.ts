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
 * Sign-in: main also owns the {@link AuthManager} — the OAuth flow, tokens, and
 * the daemon handoff (each fresh ID token → the daemon's `authenticate` command, which swaps its S3
 * credentials to the signed-in user so uploads land under `blobs/<identityId>/`). The redirect
 * arrives as a `coldstorage://auth/callback` deep link (packaged; scheme registered via
 * electron-builder `protocols`) or on the dev loopback listener (see auth/loopback.ts).
 *
 * ESM main (package.json `type: module`): use `import.meta.dirname`, not `__dirname`.
 */
import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import electronUpdater from "electron-updater";
import updaterLog from "electron-log/main";
import { DaemonClient } from "../daemon/client.ts";
import { registerBridge } from "./bridge.ts";
import { registerSystemHandlers } from "./system.ts";
import { startDaemon, daemonSocketPath, appIdentity } from "./daemon.ts";
import { AuthManager } from "./auth/manager.ts";
import { resolveOAuthConfig } from "./auth/config.ts";
import { registerAuthIpc } from "./auth/ipc.ts";
import { VaultManager } from "./vault/manager.ts";
import { VaultStore } from "./vault/storage.ts";
import { KeyBlobClient } from "./vault/keyblob-client.ts";
import { resolveAccountApiBaseUrl } from "./vault/config.ts";
import { registerVaultIpc } from "./vault/ipc.ts";
import { EntitlementManager } from "./entitlement/manager.ts";
import { registerEntitlementIpc } from "./entitlement/ipc.ts";
import { AccountManager } from "./account/manager.ts";
import { registerAccountIpc } from "./account/ipc.ts";
import { UpdateManager, type UpdaterPort } from "./updater/manager.ts";
import { registerUpdateIpc } from "./updater/ipc.ts";

// The build's install identity (productName + deep-link scheme), from the baked config (ui/identity.json →
// bake). Per lane, so a staging build is "ColdStorage Staging.app" with its own data dir + coldstorage-staging://
// scheme and installs alongside prod. Resolved ONCE here; the whole main process reads these two.
const { productName, scheme } = appIdentity();

// Pin the app name BEFORE any `getPath("userData")` call. The client resolves the socket path at module
// load and the daemon supervisor resolves it in `whenReady`; both derive from userData (= appData + app
// name). If the name weren't settled identically at both moments the two paths could diverge and never
// meet (→ stuck "connecting"). Pinning it to the productName makes userData deterministic from the start.
app.setName(productName);

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

// Which lane this build talks to. A packaged build reads it from the BAKED config and refuses to guess
// (vault/config.ts) — so this can throw, and when it does the only honest move is to say why and stop:
// an app that doesn't know its own backend would sign people in against the wrong database.
let accountApiBaseUrl: string;
try {
  accountApiBaseUrl = resolveAccountApiBaseUrl();
} catch (e) {
  dialog.showErrorBox("ColdStorage can't start", e instanceof Error ? e.message : String(e));
  app.exit(1);
  throw e; // app.exit doesn't return, but TS can't know that
}

// The zero-knowledge vault (encryption-key half of being signed in). Escrows the MasterKey per-account
// in userData/vault.json (safeStorage), fetches/stores the key-blob at the account backend, and drives
// the daemon's mint/unlock/lock commands. Only ever exercised in multi-user mode (its provision runs
// after a successful `authenticate`, which only happens when sign-in is configured).
const vault = new VaultManager(
  client,
  new VaultStore(join(app.getPath("userData"), "vault.json")),
  new KeyBlobClient(accountApiBaseUrl),
  () => auth.getFreshIdToken(),
  updaterLog, // every handoff step + failure → main.log
);
const disposeVaultIpc = registerVaultIpc(vault);

// Subscription entitlement (billing gate on deposits). Shares the account backend + the signed-in ID
// token; drives Paddle checkout in the system browser and polls until the webhook flips it active.
const entitlement = new EntitlementManager(accountApiBaseUrl, () => auth.getFreshIdToken());
const disposeEntitlementIpc = registerEntitlementIpc(entitlement);

// The account profile + onboarding facts (first-run wizard). Same backend, same token plumbing.
const account = new AccountManager(accountApiBaseUrl, () => auth.getFreshIdToken());
const disposeAccountIpc = registerAccountIpc(account);

// ── Auto-update — packaged app only. electron-updater checks the GitHub Releases feed
//    (electron-builder.yml `publish`), background-downloads a newer SIGNED + notarized build, and installs
//    it on the next quit (or on demand via the "Restart to update" affordance). In dev we hand the manager
//    an inert no-op port so the IPC + renderer path is identical but does nothing — auto-update can't run
//    on an unpackaged/unsigned app. electron-updater is CommonJS; destructure the default export (the
//    documented ESM interop). ──
const { autoUpdater } = electronUpdater;
// Give the updater somewhere to WRITE. electron-updater's default logger is `console`
// (AppUpdater: `protected _logger: Logger = console`), and a Finder-launched .app has no console — so
// every "Checking for update", "Found version X" and, critically, every failure went to a stdout nobody
// would ever read. A silent updater that has been erroring for weeks is indistinguishable from one with
// nothing to do (PILLAR5). electron-log's file transport writes to Electron's own logs dir — on macOS
// ~/Library/Logs/<productName>/main.log — which is exactly where `ui:mac:update:doctor` looks. (v5 wants
// the `electron-log/main` entry in the main process; the bare specifier is the renderer's.)
autoUpdater.logger = updaterLog;
updaterLog.transports.file.level = "info";
const updaterPort: UpdaterPort = app.isPackaged
  ? {
      get autoDownload(): boolean {
        return autoUpdater.autoDownload;
      },
      set autoDownload(v: boolean) {
        autoUpdater.autoDownload = v;
      },
      // autoUpdater is a NodeJS.EventEmitter with stringly-typed events; adapt it to the narrow port with
      // one safe upcast at this boundary. The manager's listeners take `unknown` and read defensively.
      on: (event, listener) => {
        (autoUpdater as NodeJS.EventEmitter).on(event, listener);
      },
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      quitAndInstall: () => autoUpdater.quitAndInstall(),
    }
  : {
      autoDownload: false,
      on: () => {},
      checkForUpdates: () => Promise.resolve(),
      quitAndInstall: () => {},
    };
const updater = new UpdateManager(updaterPort);
const disposeUpdateIpc = registerUpdateIpc(updater);

// ── Deep links (macOS delivers them as open-url, launch AND while running). Registered before
//    `ready` because a URL can be what LAUNCHES the app — those arrive pre-ready and are buffered.
//    (The scheme itself comes from Info.plist CFBundleURLTypes — electron-builder `protocols` — so
//    this is packaged-only in practice; setAsDefaultProtocolClient just claims default-handler.) ──
let pendingDeepLink: string | null = null;
// Route a deep link: the checkout-complete nudge → an entitlement re-check; everything else → the auth
// callback handler (which ignores non-auth URLs).
const handleDeepLink = (url: string): void => {
  if (url.startsWith(`${scheme}://checkout-complete`)) {
    entitlement.notifyCheckoutComplete();
    focusMainWindow();
    return;
  }
  void auth.handleCallbackUrl(url);
};
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleDeepLink(url);
  else pendingDeepLink = url;
});
if (app.isPackaged) app.setAsDefaultProtocolClient(scheme);

// Single-instance hygiene. macOS Launch Services already routes protocol URLs to the running instance
// (as open-url), but the lock guards CLI double-launches — and on Win/Linux (if we ever ship there)
// protocol URLs arrive via second-instance argv instead, so the shape is already right.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${scheme}://`));
    if (url) handleDeepLink(url);
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
// Push the signed-in account's storage quota to the daemon so it enforces the ceiling on EVERY run —
// including its own periodic auto-run, which the renderer's gate never sees. A null quota (dogfood, or a
// plan the app couldn't resolve) sends no `quotaBytes`, which CLEARS enforcement — failing open, exactly
// like the app-side gate; a missing number must never masquerade as "you're full".
const pushQuota = (): void => {
  const { quotaBytes } = entitlement.entitlementStatus();
  void client
    .request("setQuota", quotaBytes != null ? { quotaBytes: String(quotaBytes) } : {})
    .catch((e: unknown) => console.error("setQuota failed:", e));
};

const provisionDaemon = async (idToken: string): Promise<void> => {
  vault.setStep("Signing the background service in…");
  await client.request("authenticate", { idToken });
  await vault.provision(idToken);
  // `authenticate` resets the daemon's quota (a quota belongs to one user), so re-push it after every
  // provision — this covers a daemon (re)connect, where the entitlement is already known and won't re-fire.
  pushQuota();
};
// A failure here that ISN'T just "the daemon isn't connected yet" (which the reconnect handler below
// retries) means authenticate itself failed — surface it in the vault status so the UI shows a real
// error instead of hanging on "Setting up…" forever.
const onProvisionFailure = (e: unknown): void => {
  const msg = e instanceof Error ? e.message : String(e);
  updaterLog.error("daemon provision failed:", msg);
  if (!msg.includes("not connected")) vault.markProvisionError(msg);
};
// **Provision until it sticks.** `authenticate` is the daemon's own sign-in — a Cognito round trip — and
// it fails for the most ordinary reason there is: no network for a few seconds right after launch or
// wake. It used to be fired once per fresh token and then left alone until the NEXT token, an hour
// later. For that hour the daemon held no session and answered every read with an empty-but-successful
// nothing — which the app showed as an empty vault (2026-08-25). So: retry with backoff (2 s → 60 s
// cap) until it succeeds, a newer token supersedes it, or the socket drops (the reconnect handler
// starts a fresh attempt). The first failure is still surfaced (`onProvisionFailure`) so the UI shows
// what is being retried rather than a silent spinner.
let provisionAttempt = 0;
let provisionTimer: ReturnType<typeof setTimeout> | null = null;
const cancelProvisionRetry = (): void => {
  provisionAttempt++;
  if (provisionTimer) clearTimeout(provisionTimer);
  provisionTimer = null;
};
const provisionWithRetry = (idToken: string): void => {
  cancelProvisionRetry();
  const attempt = provisionAttempt;
  let delayMs = 2_000;
  const tryOnce = (): void => {
    provisionDaemon(idToken).catch((e: unknown) => {
      if (attempt !== provisionAttempt) return; // superseded by a newer token / disconnect
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not connected")) return; // the reconnect handler owns this case
      // A retryable failure is NOT terminal: keep the gate in its narrated "Setting up…" state (the step
      // line + the >20s "taking too long, see main.log" escalation carry the honest pending signal), rather
      // than flashing "Couldn't set up encryption" while a retry is already scheduled 2s out (PILLAR5 —
      // don't show a terminal error for work that's still in flight). The failure is still logged.
      updaterLog.error(`daemon provision failed (retrying in ${delayMs / 1000}s): ${msg}`);
      vault.setStep("Reconnecting to set up encryption…");
      provisionTimer = setTimeout(tryOnce, delayMs);
      delayMs = Math.min(delayMs * 2, 60_000);
    });
  };
  tryOnce();
};
const offIdToken = auth.onIdToken((idToken) => {
  provisionWithRetry(idToken);
  // Re-check the subscription + account profile on every fresh token (sign-in + refresh) —
  // independent of the daemon. The account refresh also records terms acceptance (sign-in-wrap).
  void entitlement.refresh();
  void account.refresh();
});
// Whenever the entitlement changes (a checkout lands, a cancellation takes effect, the first fetch
// resolves), re-push the quota so the daemon's ceiling tracks the plan the user is actually on.
const offEntitlementQuota = entitlement.onStatus(() => pushQuota());
const offClientConnect = client.on("connect", () => {
  updaterLog.info(`daemon socket connected: ${client.socketPath}`);
  void auth
    .getFreshIdToken()
    .then((idToken) => {
      if (idToken) return provisionWithRetry(idToken);
      // Not an error — a signed-out install connects too — but it IS the reason the handoff isn't
      // happening, and it used to be silent. The next fresh token (`onIdToken`) picks it up.
      updaterLog.info("daemon connected, but there is no sign-in token yet — the handoff waits for one");
      vault.setStep("Waiting for your sign-in…");
    })
    .catch(onProvisionFailure);
});
// A dropped socket makes any pending retry moot — the (re)connect above starts over.
const offClientDisconnect = client.on("disconnect", (err) => {
  updaterLog.error(`daemon socket disconnected (${err?.message ?? "no reason"}) — reconnecting every ${client.reconnectDelayMs / 1000}s: ${client.socketPath}`);
  vault.setStep("Connecting to the background service…");
  cancelProvisionRetry();
});

// Bring the window back when a sign-in completes — the user is off in the browser; the deep link
// should land them back in the app, signed in. And when sign-out happens, tell the vault to relock the
// daemon (drop the MasterKey). (Focus only on signingIn→signedIn, not background refreshes.)
let prevAuthState = auth.status().state;
const offAuthFocus = auth.onStatus((s) => {
  if (prevAuthState === "signingIn" && s.state === "signedIn") focusMainWindow();
  if (prevAuthState !== "signedOut" && s.state === "signedOut") {
    void vault.relock();
    // The credentials half of sign-out (relock is the key half): the daemon drops its cached STS
    // creds + vault prefix now rather than holding them for the remainder of the ~1h expiry. Same
    // daemon-may-be-down tolerance as relock — the daemon drops everything on exit anyway.
    void client.request("deauthenticate").catch((e: unknown) => console.error("deauthenticate failed:", e));
    entitlement.reset();
    account.reset();
  }
  prevAuthState = s.state;
});

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    // The floor where the layout still works rather than merely renders: the 232px sidebar plus a main
    // column wide enough for the file list's fixed size/date/actions columns to leave the name readable.
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: productName, // staging window reads "ColdStorage Staging" so you can tell the two installs apart
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Renderer errors land in `main.log` — the file `ui:mac:update:doctor` already reads — instead of a
  // devtools console no packaged build ever opens. "[coldstore] files refresh failed" had been printing
  // there, unread, through an entire "my vault is empty" incident (2026-08-25, PILLAR5). Errors only:
  // the renderer's console.log is chatter, its console.error is a fault.
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") updaterLog.error(`[renderer] ${details.message}`);
  });

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
    // Begin auto-update: an immediate check + a periodic one. Background-downloads a newer signed build;
    // the renderer shows a quiet "Restart to update" affordance when one is ready (update-downloaded).
    updater.start();
  }

  // Dial the daemon. If it's not up yet (the child is still binding its socket), autoReconnect keeps
  // retrying; the renderer shows "connecting" until a 'connect' lifecycle push arrives. Non-fatal.
  vault.setStep("Connecting to the background service…");
  client.connect().catch((e: unknown) => {
    // The reconnect loop owns recovery; this is the one line that says the FIRST dial lost the race.
    updaterLog.info(`daemon socket: first dial failed (${e instanceof Error ? e.message : String(e)}) — retrying`);
  });

  // Silent session restore (safeStorage needs `ready` for the Keychain), then any deep link that
  // LAUNCHED the app. Both async; the renderer just sees status pushes whenever they land.
  void auth.restore().then(() => {
    if (pendingDeepLink) {
      handleDeepLink(pendingDeepLink);
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
  disposeEntitlementIpc();
  disposeAccountIpc();
  disposeUpdateIpc();
  offIdToken();
  offEntitlementQuota();
  offClientConnect();
  offClientDisconnect();
  cancelProvisionRetry();
  offAuthFocus();
  auth.dispose();
  vault.dispose();
  entitlement.dispose();
  account.dispose();
  updater.dispose();
  client.close();
  stopDaemon(); // terminate the supervised child (no-op in dev)
});
