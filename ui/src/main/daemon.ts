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
 * `~/Library/Application Support/ColdStorage` (the productName), which is ALSO the `DATA_DIR` that
 * `task daemon:mac:logs` tails — so the packaged daemon's logs land where the existing ops task expects.
 * Exported for the auth config resolver (config.json is the packaged app's whole config seam). */
export const dataDir = (): string => app.getPath("userData");

/** The control-socket path the daemon creates AND the client dials — one value, both sides agree on it
 * (passed to `new DaemonClient({ socketPath })` in index.ts). */
export const daemonSocketPath = (): string => join(dataDir(), "coldstored.sock");

/** Absolute path to the bundled daemon binary (Contents/Resources/bin — see electron-builder.yml). */
const coldstoredPath = (): string => join(process.resourcesPath, "bin", "coldstored");

/** Absolute path to the BAKED config bundled into the app (Contents/Resources/app-config.json — written
 * at package time by `task ui:config:bake`, see electron-builder.yml extraResources). This carries the
 * public prod defaults (bucket/region/Cognito/sign-in/account-API) so a stranger's download self-configures
 * — sign-in is the only setup left (PROD.md Phase 6d). Only present in a packaged build. */
const bakedConfigPath = (): string => join(process.resourcesPath, "app-config.json");

/** The packaged app's per-user config, resolved as **baked base ← user override**:
 *   - baked  = `Contents/Resources/app-config.json` (the public prod config, packaged builds only) — the
 *     SSOT that makes a config-less customer download work; NO secret (creds come via Cognito STS).
 *   - user   = `<dataDir>/config.json` (written by `task ui:mac:config`) — dev/dogfood overrides on top, e.g.
 *     `awsProfile` for the credential_process path, or a MinIO/staging bucket for testing.
 * A missing file on either side is normal (a customer has no user file; dev has no baked file), so this
 * silently degrades: uploads just fail clean until something supplies bucket + Cognito, the daemon still
 * serves its control socket. `cognitoIdentityPoolId`/`cognitoUserPoolProvider` are the daemon's multi-user
 * seam (Phase 2); `cognitoDomain`/`cognitoClientId` are the APP's sign-in config (Phase 5, auth/config.ts). */
export const readAppConfig = (dir: string): AppConfig => {
  const baked = app.isPackaged ? readConfigFile(bakedConfigPath()) : {};
  const user = readConfigFile(join(dir, "config.json"));
  return mergeAppConfig(baked, user);
};

/** The env `coldstored` reads (see coldstored/main.swift) — per-user paths under {@link dataDir}, plus the
 * AWS bucket/region/profile from {@link readAppConfig} so a Finder-launched app (which inherits no shell
 * env) can actually upload. Only keys present in config.json are set, so `coldstored`'s own defaults still
 * apply when it's absent. Creds = `AWS_PROFILE` → credential_process → Keychain (no secret in env). */
const daemonEnv = (dir: string): NodeJS.ProcessEnv => {
  const cfg = readAppConfig(dir);
  return {
    ...process.env,
    COLDSTORE_SOCKET: join(dir, "coldstored.sock"),
    COLDSTORE_JOURNAL: join(dir, "coldstore.sqlite"),
    COLDSTORE_KEK: join(dir, "kek.bin"),
    COLDSTORE_STAGING: join(dir, "staging"),
    COLDSTORE_STATUS: join(dir, "status.json"),
    ...(cfg.bucket ? { COLDSTORE_BUCKET: cfg.bucket } : {}),
    ...(cfg.region ? { AWS_REGION: cfg.region } : {}),
    ...(cfg.awsProfile ? { AWS_PROFILE: cfg.awsProfile } : {}),
    ...(cfg.cognitoIdentityPoolId ? { COLDSTORE_COGNITO_IDENTITY_POOL_ID: cfg.cognitoIdentityPoolId } : {}),
    ...(cfg.cognitoUserPoolProvider ? { COLDSTORE_COGNITO_USER_POOL_PROVIDER: cfg.cognitoUserPoolProvider } : {}),
  };
};

/**
 * Spawn + supervise `coldstored`. Returns a disposer that stops the supervisor and terminates the child.
 * Restarts on unexpected exit after a short backoff (so a crash-loop can't peg the CPU); a disposer call
 * suppresses further restarts. stdout/stderr → `coldstored.{out,err}.log` in the data dir (what
 * `task daemon:mac:logs` tails — incl. the PhotoKitResolver auth diagnostics).
 */
export const startDaemon = (): (() => void) => {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, "coldstored.out.log"), "a");
  const err = openSync(join(dir, "coldstored.err.log"), "a");

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
