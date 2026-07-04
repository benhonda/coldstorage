/**
 * The main↔renderer IPC contract (layer 2). SSOT for the seam between Electron's main process — which
 * owns the one {@link DaemonClient} and the unix socket — and the renderer, which never touches the
 * socket and only sees the narrow {@link ColdstoreApi} the preload exposes on `window.coldstore`.
 *
 * Two directions:
 *   - commands  renderer → main → daemon : one invoke channel ({@link IPC.request}), id-multiplexed
 *               request/response handled by the layer-1 client. Typed end-to-end via {@link Commands}.
 *   - pushes    main → renderer          : daemon events ({@link IPC.event}) and connection lifecycle
 *               ({@link IPC.lifecycle}), broadcast to every window's webContents.
 *
 * Daemon wire types are re-exported here so the renderer binds to ONE seam (never reaches into
 * `daemon/`, which is main-process-only). They're type-only — `protocol.ts` has zero runtime/Node deps.
 */
export type {
  Ack,
  Commands,
  ConflictPolicy,
  DaemonEventName,
  DaemonEvents,
  DepositPreviewItem,
  ListedFile,
  Method,
  ParamsArg,
  Pricing,
  RestoreStep,
  Source,
  Status,
  TierQuote,
} from "../daemon/protocol.ts";

import type { Commands, DaemonEventName, DaemonEvents, Method, ParamsArg } from "../daemon/protocol.ts";

/** Channel names. Namespaced so they never collide with other IPC a window might use. */
export const IPC = {
  /** invoke: send a command, await its reply (or rejection). */
  request: "daemon:request",
  /** invoke: read the current connection state (so a fresh window initializes without waiting). */
  connectionState: "daemon:connectionState",
  /** push: one daemon event, `(name, data)`. */
  event: "daemon:event",
  /** push: connection lifecycle changed, `(state)`. */
  lifecycle: "daemon:lifecycle",
  /** invoke: open the native folder picker; resolves to the chosen path or null. */
  chooseFolder: "dialog:chooseFolder",
  /** invoke: the OS Downloads directory (default save destination). */
  downloadsDir: "dialog:downloadsDir",
  /** invoke: present the native Photos picker; resolves to the picked asset ids (or [] if cancelled). */
  pickPhotos: "photos:pick",
  /** invoke: open System Settings ▸ Privacy & Security ▸ Photos (recovery for a denied/limited grant). */
  openPhotosSettings: "photos:openSettings",
  /** invoke: current {@link AuthStatus} — for first paint before any push arrives. */
  authStatus: "auth:status",
  /** invoke: start a sign-in (opens the system browser; completes asynchronously via a status push). */
  authSignIn: "auth:signIn",
  /** invoke: sign out (drops the stored session + revokes it server-side). */
  authSignOut: "auth:signOut",
  /** invoke: email-code lane — send a one-time code to `(email)`. */
  authEmailStart: "auth:emailStart",
  /** invoke: email-code lane — submit the code `(code)` to finish signing in. */
  authEmailSubmit: "auth:emailSubmit",
  /** invoke: abandon an in-progress email sign-in. */
  authEmailCancel: "auth:emailCancel",
  /** push: the auth status changed, `(status)`. */
  authStatusChanged: "auth:statusChanged",
  /** invoke: current {@link VaultStatus} — for first paint before any push arrives. */
  vaultStatus: "vault:status",
  /** invoke: submit a recovery code to unlock the vault on a new device. */
  vaultSubmitRecoveryCode: "vault:submitRecoveryCode",
  /** invoke: acknowledge the one-time recovery code was saved (clears it from status). */
  vaultAckRecoveryCode: "vault:ackRecoveryCode",
  /** push: the vault status changed, `(status)`. */
  vaultStatusChanged: "vault:statusChanged",
  /** invoke: current {@link EntitlementStatus}. */
  entitlementStatus: "entitlement:status",
  /** invoke: start a subscription checkout (opens the system browser + polls). */
  entitlementSubscribe: "entitlement:subscribe",
  /** push: the entitlement status changed, `(status)`. */
  entitlementStatusChanged: "entitlement:statusChanged",
  /** invoke: current {@link UpdateStatus} — for first paint before any push arrives. */
  updateStatus: "update:status",
  /** invoke: check for an app update now (the app also checks on launch + periodically). */
  updateCheck: "update:check",
  /** invoke: quit and install a downloaded update (meaningful only when state === "ready"). */
  updateRestart: "update:restart",
  /** push: the update status changed, `(status)`. */
  updateStatusChanged: "update:statusChanged",
} as const;

/** Whether the main process currently holds a live socket to `coldstored`. */
export type ConnectionState = "connecting" | "connected" | "disconnected";

/**
 * The renderer's whole view of sign-in (PROD.md Phase 5) — no token ever crosses this seam.
 * `configured: false` = single-operator dogfood mode (no Cognito sign-in config present); the UI
 * hides the auth surface entirely and behaves exactly as before Phase 5.
 */
export interface AuthStatus {
  configured: boolean;
  /** `restoring` = launch-time: a saved session is being checked/refreshed, so the answer (signed in or
   * out) isn't known yet. The app shows a neutral "checking…" screen for it, never the login screen —
   * otherwise a returning user flashes past "Continue with Google" before their session restores. */
  state: "restoring" | "signedOut" | "signingIn" | "signedIn";
  /** From the ID token's email claim — display only (verification happens daemon/backend-side). */
  email: string | null;
  /** The most recent sign-in failure, for the sign-in screen. Null when none (including a plain
   * user-cancelled attempt, which isn't an error worth showing). */
  error: string | null;
  /** Whether the email-code lane is available (5b-3) — the sign-in screen shows the email option only
   * when true (it needs the pool region, resolved from the managed-login domain). */
  emailAvailable: boolean;
}

/**
 * The renderer's view of the zero-knowledge vault (PROD.md Phase 5b) — the encryption-key half of being
 * signed in, distinct from {@link AuthStatus} (the AWS-credentials half). No key material crosses this
 * seam EXCEPT `recoveryCode`, which is shown once at signup and then acknowledged away.
 *   - `locked`         signed out, or not yet provisioned.
 *   - `provisioning`   fetching/minting the key-blob, unlocking the daemon.
 *   - `unlocked`       the daemon holds the MasterKey; deposits encrypt under it.
 *   - `needsRecoveryCode`  existing account on a NEW device — the user must enter their recovery code.
 *   - `error`          provisioning failed (backend unreachable, etc.); retryable.
 */
export interface VaultStatus {
  state: "locked" | "provisioning" | "unlocked" | "needsRecoveryCode" | "error";
  /** Set ONLY immediately after a fresh signup mint: the one-time recovery code to show the user once.
   * Never persisted, never re-derivable. Cleared as soon as the user acknowledges saving it. */
  recoveryCode: string | null;
  error: string | null;
}

/**
 * Subscription entitlement (PROD.md Phase 5c) — the billing gate on DEPOSITS (browse/restore stay open).
 * `known` guards against gating before the first check lands (don't paywall on a transient unknown).
 */
export interface EntitlementStatus {
  /** Whether entitlement has been fetched at least once for the signed-in user. */
  known: boolean;
  active: boolean;
  /** A checkout is open in the browser and we're polling for the webhook to flip `active`. */
  checkingOut: boolean;
  error: string | null;
}

/**
 * Auto-update status (PROD.md Phase 6), pushed from main. The packaged app checks a GitHub Releases feed
 * on launch + periodically, downloads a newer signed build in the background, and installs it on the next
 * quit/restart. Auto-update only runs in the packaged, signed app — in dev this stays `idle` forever.
 *   - `idle`         no update known (startup, or the last check found nothing newer).
 *   - `checking`     a check is in flight.
 *   - `available`    a newer version was found and is starting to download (autoDownload is on).
 *   - `downloading`  the newer build is downloading (`percent` populated).
 *   - `ready`        a newer build is downloaded and will install on the next quit — or now via `restartToUpdate`.
 *   - `error`        the last check/download failed. Non-fatal: the app keeps running the current version.
 */
export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  /** The target version once known (`available`/`downloading`/`ready`); null otherwise. */
  version: string | null;
  /** Download progress 0–100 while `downloading`; null otherwise. */
  percent: number | null;
  /** The last update error, display-only. Null when none. */
  error: string | null;
}

/** One photo picked in the native picker: the PHAsset localIdentifier (drives the daemon `depositPhotos`)
 * + a suggested name for the instant optimistic row label (the daemon resolves the true filename later). */
export interface PhotoPick {
  id: string;
  name: string;
}

/**
 * The surface the preload exposes on `window.coldstore` via `contextBridge`. The renderer's entire
 * view of the backend — typed against the daemon contract, with no access to Node, the socket, or
 * `ipcRenderer`. Subscriptions return an unsubscribe fn (call it on unmount).
 */
export interface ColdstoreApi {
  /** Send a command to the daemon and await its typed reply. Rejects on daemon error / timeout / drop. */
  request<M extends Method>(method: M, ...params: ParamsArg<M>): Promise<Commands[M]["result"]>;
  /** Current connection state — for first paint before any lifecycle push arrives. */
  getConnectionState(): Promise<ConnectionState>;
  /** Subscribe to every daemon-pushed event (tagged with its name). */
  onEvent(listener: <E extends DaemonEventName>(name: E, data: DaemonEvents[E]) => void): () => void;
  /** Subscribe to connection-state changes. */
  onLifecycle(listener: (state: ConnectionState) => void): () => void;
  /** Open the native folder picker (a window sheet on macOS). Resolves to the chosen absolute path, or
   * null if cancelled. `defaultPath` seeds where it opens. */
  chooseFolder(defaultPath?: string): Promise<string | null>;
  /** The OS Downloads directory (absolute) — the default save destination for a requested copy. */
  getDownloadsDir(): Promise<string>;
  /** Present the native macOS Photos picker (option B) and resolve to the picked photos ({id, name}), or []
   * if the user cancelled / picked nothing. The renderer shows optimistic rows from the names and hands the
   * ids to the daemon's `depositPhotos`. macOS-only — rejects if the picker helper is missing or fails. */
  pickPhotos(): Promise<PhotoPick[]>;
  /** Open System Settings ▸ Privacy & Security ▸ Photos so the user can grant ColdStorage full Photos
   * access — the recovery path when a deposit failed with `photosAccessDenied`. macOS-only. */
  openPhotosSettings(): Promise<void>;
  /** Absolute path of a dropped/picked File. Electron 32+ removed `File.path`; resolved in the preload
   * via `webUtils.getPathForFile`. "" if it can't be resolved (e.g. a synthetic File). Sync — no daemon. */
  pathForFile(file: File): string;
  /** Current sign-in status — for first paint before any {@link onAuthStatus} push arrives. */
  getAuthStatus(): Promise<AuthStatus>;
  /** Start a sign-in: main opens the system browser at Cognito managed login; completion arrives as
   * an {@link onAuthStatus} push (the browser redirect comes back to the main process, not here). */
  signIn(): Promise<void>;
  /** Sign out: drops the stored session and revokes it server-side. */
  signOut(): Promise<void>;
  /** Email-code lane: send a one-time code to `email` (handles both sign-in and self-service signup).
   * Resolves when the code is on its way; rejects with a user-facing message on a bad email / error. */
  startEmailSignIn(email: string): Promise<void>;
  /** Email-code lane: submit the emailed code to finish signing in. Resolves on success (watch
   * {@link onAuthStatus} for `signedIn`); rejects with a message on a wrong/expired code. */
  submitEmailCode(code: string): Promise<void>;
  /** Abandon an in-progress email sign-in (e.g. the user switched to Google). */
  cancelEmailSignIn(): Promise<void>;
  /** Subscribe to sign-in status changes. */
  onAuthStatus(listener: (status: AuthStatus) => void): () => void;
  /** Current vault status — for first paint before any {@link onVaultStatus} push arrives. */
  getVaultStatus(): Promise<VaultStatus>;
  /** Submit a recovery code to unlock the vault on a new device. Rejects (with a message) on a wrong
   * code; a resolved promise means the vault is unlocking (watch {@link onVaultStatus}). */
  submitRecoveryCode(code: string): Promise<void>;
  /** Acknowledge the one-time recovery code was saved — clears it from the vault status. */
  acknowledgeRecoveryCode(): Promise<void>;
  /** Subscribe to vault status changes. */
  onVaultStatus(listener: (status: VaultStatus) => void): () => void;
  /** Current subscription entitlement — for first paint before any push arrives. */
  getEntitlement(): Promise<EntitlementStatus>;
  /** Start a subscription checkout: opens Paddle checkout in the system browser and polls until the
   * webhook marks the subscription active (watch {@link onEntitlement}). Rejects if checkout can't start. */
  subscribe(): Promise<void>;
  /** Subscribe to entitlement changes. */
  onEntitlement(listener: (status: EntitlementStatus) => void): () => void;
  /** Current auto-update status — for first paint before any {@link onUpdateStatus} push arrives.
   * Always `idle` in dev (auto-update only runs in the packaged, signed app). */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Check for an app update now. The app also checks on launch and periodically; this backs a manual
   * "Check for updates" affordance. Resolves once the check is kicked off (watch {@link onUpdateStatus}). */
  checkForUpdate(): Promise<void>;
  /** Quit and install a downloaded update (state === "ready"); the app relaunches on the new version. */
  restartToUpdate(): Promise<void>;
  /** Subscribe to auto-update status changes. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
}
