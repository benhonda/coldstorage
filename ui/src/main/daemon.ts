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

/** Per-user data dir — the SSOT for everything the daemon persists. `userData` resolves to
 * `~/Library/Application Support/ColdStorage` (the productName), which is ALSO the `DATA_DIR` that
 * `task daemon:logs` tails — so the packaged daemon's logs land where the existing ops task expects. */
const dataDir = (): string => app.getPath("userData");

/** The control-socket path the daemon creates AND the client dials — one value, both sides agree on it
 * (passed to `new DaemonClient({ socketPath })` in index.ts). */
export const daemonSocketPath = (): string => join(dataDir(), "coldstored.sock");

/** Absolute path to the bundled daemon binary (Contents/Resources/bin — see electron-builder.yml). */
const coldstoredPath = (): string => join(process.resourcesPath, "bin", "coldstored");

/** The env `coldstored` reads (see coldstored/main.swift) — per-user paths under {@link dataDir}; the
 * launch env passes through for AWS bucket/region. NOTE: wiring production AWS credentials into a
 * Finder-launched app (which inherits no shell env) is a SEPARATE milestone — the daemon still STARTS and
 * serves the control socket without them (creds resolve lazily; only uploads need them), which is all
 * this step needs to get the UI connected. */
const daemonEnv = (dir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  COLDSTORE_SOCKET: join(dir, "coldstored.sock"),
  COLDSTORE_JOURNAL: join(dir, "coldstore.sqlite"),
  COLDSTORE_KEK: join(dir, "kek.bin"),
  COLDSTORE_STAGING: join(dir, "staging"),
  COLDSTORE_STATUS: join(dir, "status.json"),
});

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
