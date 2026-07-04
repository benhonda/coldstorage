/**
 * Auto-update manager (PROD.md Phase 6) — **packaged app only**. Owns the {@link UpdateStatus} the
 * renderer sees, folded from electron-updater's event stream. The packaged app checks a GitHub Releases
 * feed (electron-builder.yml `publish`), downloads a newer *signed + notarized* build in the background,
 * and installs it on quit — or immediately when the user hits "Restart to update" ({@link restart}).
 *
 * Depends on the narrow {@link UpdaterPort}, not electron-updater directly, so the state machine is
 * unit-testable headless (see manager.test.ts) with a fake port. The real port (an adapter over
 * `electronUpdater.autoUpdater`) is built once at the boundary in index.ts — the same "one cast at the
 * seam" discipline the daemon bridge follows.
 *
 * macOS caveat: auto-update only applies to a **signed** app (an ad-hoc/unsigned build errors on apply),
 * so this does real work only once Phase 6a's Developer ID signing is in place. Errors are non-fatal —
 * they surface as `state: "error"` and the app keeps running the current version.
 */
import type { UpdateStatus } from "../../shared/ipc.ts";

/** The slice of electron-updater's `autoUpdater` this manager uses. Kept narrow so tests inject a fake
 * and the real adapter has an obvious, tiny surface. Events carry `unknown` — the manager reads only the
 * fields it needs, defensively (the payload shape is electron-updater's, not ours to trust structurally). */
export interface UpdaterPort {
  /** Background-download a found update (so `update-available` flows straight into `download-progress`). */
  autoDownload: boolean;
  /** Subscribe to an electron-updater lifecycle event. */
  on(event: string, listener: (payload: unknown) => void): void;
  /** Ask the feed whether a newer version exists (kicks off the event stream above). */
  checkForUpdates(): Promise<unknown>;
  /** Quit, install the downloaded update, and relaunch. */
  quitAndInstall(): void;
}

/** How often the packaged app re-checks the feed while running. Six hours — a background backup app is
 * long-lived (openAtLogin, stays alive when windows close), so it rarely quits into a natural check. */
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const IDLE: UpdateStatus = { state: "idle", version: null, percent: null, error: null };

/** Best-effort read of a `version` string off an electron-updater `UpdateInfo` payload. */
const readVersion = (payload: unknown): string | null => {
  if (typeof payload === "object" && payload !== null) {
    const v = (payload as { version?: unknown }).version;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
};

/** Best-effort read of a `percent` (0–100, rounded) off an electron-updater `ProgressInfo` payload. */
const readPercent = (payload: unknown): number | null => {
  if (typeof payload === "object" && payload !== null) {
    const p = (payload as { percent?: unknown }).percent;
    if (typeof p === "number" && Number.isFinite(p)) return Math.max(0, Math.min(100, Math.round(p)));
  }
  return null;
};

const readMessage = (payload: unknown): string =>
  payload instanceof Error ? payload.message : typeof payload === "string" ? payload : "Update failed";

export class UpdateManager {
  #status: UpdateStatus = IDLE;
  readonly #listeners = new Set<(status: UpdateStatus) => void>();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #port: UpdaterPort;

  constructor(port: UpdaterPort) {
    this.#port = port;
    port.autoDownload = true;

    // Fold electron-updater's event stream into UpdateStatus. Each handler patches only the fields it
    // knows (version survives from `available` through `downloading` into `ready`).
    port.on("checking-for-update", () => this.#patch({ state: "checking", error: null }));
    port.on("update-available", (info) =>
      this.#patch({ state: "available", version: readVersion(info), percent: null, error: null }),
    );
    port.on("download-progress", (p) => this.#patch({ state: "downloading", percent: readPercent(p) }));
    port.on("update-downloaded", (info) =>
      this.#patch({ state: "ready", version: readVersion(info) ?? this.#status.version, percent: 100, error: null }),
    );
    port.on("update-not-available", () => this.#patch({ ...IDLE }));
    port.on("error", (e) => this.#patch({ state: "error", error: readMessage(e) }));
  }

  /** Current status — for the IPC first-paint read. */
  status(): UpdateStatus {
    return this.#status;
  }

  /** Subscribe to status changes; returns an unsubscribe fn. */
  onStatus(listener: (status: UpdateStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Kick off an update check now. Rejections surface via the `error` event (electron-updater re-emits
   * them), so we swallow the promise here rather than double-reporting. */
  check(): void {
    void this.#port.checkForUpdates().catch(() => {
      /* surfaced as an `error` event → state "error" */
    });
  }

  /** Quit-and-install a downloaded update. No-ops unless one is ready (electron-updater guards this too). */
  restart(): void {
    if (this.#status.state === "ready") this.#port.quitAndInstall();
  }

  /** Begin periodic checking: an immediate check + one every `intervalMs`. Packaged-only (index.ts gates it). */
  start(intervalMs: number = DEFAULT_CHECK_INTERVAL_MS): void {
    this.check();
    this.#timer = setInterval(() => this.check(), intervalMs);
  }

  /** Stop the timer + drop subscribers (called on app quit). */
  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  #patch(patch: Partial<UpdateStatus>): void {
    const next = { ...this.#status, ...patch };
    if (
      next.state === this.#status.state &&
      next.version === this.#status.version &&
      next.percent === this.#status.percent &&
      next.error === this.#status.error
    ) {
      return; // no observable change — skip the notify (matches the store's identity-skip)
    }
    this.#status = next;
    for (const l of this.#listeners) l(next);
  }
}
