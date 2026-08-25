/**
 * Daemon supervisor — **packaged app only**. In dev the daemon runs standalone (`task daemon:run`) and
 * the UI just dials its socket; a packaged ColdStorage.app instead OWNS its `coldstored`: it spawns the
 * bundled binary as a CHILD, restarts it if it dies (the child analogue of launchd KeepAlive), and kills
 * it on quit.
 *
 * Why a child (architecture decision B — see PACKAGING.md): macOS attributes a child's TCC prompt to the
 * **responsible process** (the app that spawned it), so the Photos grant shows **"ColdStorage"**, not the
 * raw "coldstored" binary — and we avoid the native-addon rabbit hole SMAppService-from-Electron needs.
 * Tradeoff: the daemon lives with the (background) app rather than as an independent launchd service.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, openSync } from "node:fs";
import { app } from "electron";
import { type AppConfig, mergeAppConfig, readConfigFile } from "./config.ts";

export type { AppConfig } from "./config.ts";

/** Per-user data dir — the SSOT for everything the daemon persists. `userData` resolves to
 * `~/Library/Application Support/<productName>` (default ColdStorage; "ColdStorage Staging" on a staging
 * build), which is ALSO the `DATA_DIR` that
 * `task daemon:mac:logs` tails — so the packaged daemon's logs land where the existing ops task expects.
 * Exported for the auth config resolver (config.json is the packaged app's whole config seam). */
export const dataDir = (): string => app.getPath("userData");

/** The control-socket path the daemon creates AND the client dials — one value, both sides agree on it
 * (passed to `new DaemonClient({ socketPath })` in index.ts).
 *
 * **Packaged: a socket only this app knows.** `coldstored.sock` is the rendezvous the dev launchd daemon
 * (`task daemon:mac:install`, "Mode 1") and every `task daemon:mac:*` tool use. The packaged app used to
 * share it — and a Mode 1 leftover, which launchd revived at every login, then fought the app's own child
 * daemon for the path. Each daemon unlinks + rebinds on start, so whichever started last owned the PATH
 * while the app's already-open connection stayed on the OTHER one: a split brain where the app read one
 * daemon (signed out after a network blip, serving empty lists) and the CLI read the other (signed in, all
 * 140k files). The user saw a "your vault is empty" hero over a full vault (2026-08-25). A private path
 * makes that structurally impossible: the app can only ever reach the daemon it spawned. Dev (unpackaged)
 * keeps the shared path on purpose — there the UI is MEANT to dial the launchd daemon. */
export const daemonSocketPath = (): string =>
  join(dataDir(), app.isPackaged ? "coldstored.app.sock" : "coldstored.sock");

/** The packaged daemon's log files — its own pair, not Mode 1's `coldstored.{out,err}.log`, for the same
 * reason as the socket: two daemons appending to one file interleave into a log that reads as one process
 * with impossible memory swings. `task daemon:mac:logs` tails both pairs. */
export const daemonLogPaths = (): { out: string; err: string } => ({
  out: join(dataDir(), "coldstored.app.out.log"),
  err: join(dataDir(), "coldstored.app.err.log"),
});

/** Absolute path to the bundled daemon binary (Contents/Resources/bin — see electron-builder.yml). */
const coldstoredPath = (): string => join(process.resourcesPath, "bin", "coldstored");

/** Absolute path to the BAKED config bundled into the app (Contents/Resources/app-config.json — written
 * at package time by `task ui:config:bake`, see electron-builder.yml extraResources). This carries the
 * public prod defaults (bucket/region/Cognito/sign-in/account-API) so a stranger's download self-configures
 * — sign-in is the only setup left. Only present in a packaged build. */
const bakedConfigPath = (): string => join(process.resourcesPath, "app-config.json");

/** The BAKED config alone, unmerged. For the handful of values a user file must never be able to
 * override — see {@link resolveAccountApiBaseUrl}, where the backend lane is a property of the BUILD. */
export const readBakedConfig = (): AppConfig => (app.isPackaged ? readConfigFile(bakedConfigPath()) : {});

/** The build's INSTALL IDENTITY (productName + deep-link scheme), read from the BAKED config ONLY — NOT
 * merged with the user's `config.json`, because `productName` selects the userData dir the app is already
 * running on (via {@link app.setName} in index.ts); letting a dogfood override repoint it mid-flight would
 * strand data/socket. Dev (unpackaged, no baked file) ⇒ prod identity, matching the historical hardcoded
 * "ColdStorage" / "coldstorage". SSOT: `ui/identity.json` → `task ui:config:bake` → this baked file. The
 * bundle's Info.plist (electron-builder.cjs) reads the SAME baked file, so name/scheme can't diverge. */
export const appIdentity = (): { productName: string; scheme: string } => {
  const baked = readBakedConfig();
  return { productName: baked.productName ?? "ColdStorage", scheme: baked.scheme ?? "coldstorage" };
};

/** The packaged app's per-user config, resolved as **baked base ← user override**. NOTE the exception:
 * the backend lane (`accountApiBaseUrl`) does NOT come through here in a packaged build — it reads
 * {@link readBakedConfig} directly, so no user file can repoint it (`vault/config.ts`).
 *   - baked  = `Contents/Resources/app-config.json` (the public prod config, packaged builds only) — the
 *     SSOT that makes a config-less customer download work; NO secret (creds come via Cognito STS).
 *   - user   = `<dataDir>/config.json` (written by `task ui:mac:config`) — dev/dogfood overrides on top, e.g.
 *     a staging bucket for testing.
 * A missing file on either side is normal (a customer has no user file; dev has no baked file), so this
 * silently degrades: uploads just fail clean until something supplies bucket + Cognito, the daemon still
 * serves its control socket. `cognitoIdentityPoolId`/`cognitoUserPoolProvider` are the daemon's multi-user
 * seam (Phase 2); `cognitoDomain`/`cognitoClientId` are the APP's sign-in config (Phase 5, auth/config.ts). */
export const readAppConfig = (dir: string): AppConfig => {
  const baked = readBakedConfig();
  const user = readConfigFile(join(dir, "config.json"));
  return mergeAppConfig(baked, user);
};

/** The env `coldstored` reads (see coldstored/main.swift), plus the AWS bucket/region/profile from
 * {@link readAppConfig} so a Finder-launched app (which inherits no shell env) can actually upload. Only
 * keys present in config.json are set, so `coldstored`'s own defaults still apply when it's absent.
 * Creds = Cognito STS, per signed-in user. There is no other path: the daemon holds no long-lived key
 * and no AWS profile (the IAM user those pointed at was retired 2026-07-27).
 *
 * We hand the daemon a DATA ROOT, not a journal/staging/status path each. Per-user state lives at
 * `<root>/users/<sub>/…` and is opened by the daemon at sign-in, because at spawn time nobody is signed in
 * yet and there is no user whose journal it could be. Passing individual paths is what produced the
 * 2026-07-13 cross-account leak: one machine-wide `coldstore.sqlite`, handed to whoever was running,
 * survived sign-out and was served to the next account. The socket stays at the root — it's a machine-level
 * rendezvous, not user data. */
const daemonEnv = (dir: string): NodeJS.ProcessEnv => {
  const cfg = readAppConfig(dir);
  return {
    ...process.env,
    COLDSTORE_DATA_DIR: dir,
    COLDSTORE_SOCKET: daemonSocketPath(),
    ...(cfg.bucket ? { COLDSTORE_BUCKET: cfg.bucket } : {}),
    ...(cfg.region ? { AWS_REGION: cfg.region } : {}),
    ...(cfg.cognitoIdentityPoolId ? { COLDSTORE_COGNITO_IDENTITY_POOL_ID: cfg.cognitoIdentityPoolId } : {}),
    ...(cfg.cognitoUserPoolProvider ? { COLDSTORE_COGNITO_USER_POOL_PROVIDER: cfg.cognitoUserPoolProvider } : {}),
  };
};

/**
 * Spawn + supervise `coldstored`. Returns a disposer that stops the supervisor and terminates the child.
 * Restarts on unexpected exit after a short backoff (so a crash-loop can't peg the CPU); a disposer call
 * suppresses further restarts. stdout/stderr → {@link daemonLogPaths} in the data dir (what
 * `task daemon:mac:logs` tails — incl. the PhotoKitResolver auth diagnostics).
 */
export const startDaemon = (): (() => void) => {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const logs = daemonLogPaths();
  const out = openSync(logs.out, "a");
  const err = openSync(logs.err, "a");

  let child: ChildProcess | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const launch = (): void => {
    if (stopped) return;
    const proc = spawn(coldstoredPath(), [], { env: daemonEnv(dir), stdio: ["ignore", out, err] });
    child = proc;
    proc.on("error", (e) => console.error("coldstored failed to spawn:", e));
    proc.on("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      console.error(`coldstored exited (code=${code} signal=${signal}); restarting in 1s…`);
      restartTimer = setTimeout(launch, 1000);
    });
  };

  launch();

  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    child?.kill("SIGTERM");
  };
};
