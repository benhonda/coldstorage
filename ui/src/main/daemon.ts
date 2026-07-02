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
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { app } from "electron";

/** Per-user data dir — the SSOT for everything the daemon persists. `userData` resolves to
 * `~/Library/Application Support/ColdStorage` (the productName), which is ALSO the `DATA_DIR` that
 * `task daemon:logs` tails — so the packaged daemon's logs land where the existing ops task expects.
 * Exported for the auth config resolver (config.json is the packaged app's whole config seam). */
export const dataDir = (): string => app.getPath("userData");

/** The control-socket path the daemon creates AND the client dials — one value, both sides agree on it
 * (passed to `new DaemonClient({ socketPath })` in index.ts). */
export const daemonSocketPath = (): string => join(dataDir(), "coldstored.sock");

/** Absolute path to the bundled daemon binary (Contents/Resources/bin — see electron-builder.yml). */
const coldstoredPath = (): string => join(process.resourcesPath, "bin", "coldstored");

/** The packaged app's per-user AWS config — the bucket/region/profile a Finder-launched app can't get
 * from a shell env. Written by `task ui:config` (from the infra-outputs handoff, the same SSOT the launchd
 * plist uses). NO secret lives here: creds resolve via the `awsProfile`'s `credential_process → Keychain`
 * (set up once by `task daemon:creds`), exactly like the launchd daemon. `cognitoIdentityPoolId`/
 * `cognitoUserPoolProvider` are the daemon's multi-user seam (PROD.md Phase 2); `cognitoDomain`/
 * `cognitoClientId` are the APP's sign-in config (Phase 5 — managed-login host + public client id,
 * consumed by auth/config.ts, never passed to the daemon). */
export type AppConfig = {
  bucket?: string | undefined;
  region?: string | undefined;
  awsProfile?: string | undefined;
  cognitoIdentityPoolId?: string | undefined;
  cognitoUserPoolProvider?: string | undefined;
  cognitoDomain?: string | undefined;
  cognitoClientId?: string | undefined;
  /** Account-backend base URL (Phase 5b) — where the app fetches/stores the zero-knowledge key-blob and
   * checks entitlement. Absent ⇒ the staging default (which accepts production Cognito tokens). */
  accountApiBaseUrl?: string | undefined;
};

/** Read `<dataDir>/config.json` best-effort. A missing/malformed file logs and returns `{}` so the daemon
 * still starts + serves the control socket (the UI connects; only uploads need this) — the graceful
 * "connected but can't upload" degrade, not a hard failure. */
export const readAppConfig = (dir: string): AppConfig => {
  const path = join(dir, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`no ${path} — daemon will start but can't upload. Run \`task ui:config\` on your Mac (see ui/PACKAGING.md).`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object");
    const o = parsed as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
    return {
      bucket: str(o.bucket),
      region: str(o.region),
      awsProfile: str(o.awsProfile),
      cognitoIdentityPoolId: str(o.cognitoIdentityPoolId),
      cognitoUserPoolProvider: str(o.cognitoUserPoolProvider),
      cognitoDomain: str(o.cognitoDomain),
      cognitoClientId: str(o.cognitoClientId),
      accountApiBaseUrl: str(o.accountApiBaseUrl),
    };
  } catch (e) {
    console.error(`ignoring malformed ${path}: ${String(e)}`);
    return {};
  }
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
 * `task daemon:logs` tails — incl. the PhotoKitResolver auth diagnostics).
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
