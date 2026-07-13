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
  RestoreStep,
  Source,
  Status,
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
  /** invoke: the sellable plan catalog `(→ CatalogPlan[])` — what the subscribe picker renders. */
  entitlementCatalog: "entitlement:catalog",
  /** invoke: start a subscription checkout for a chosen plan `(priceId)` (opens the system browser + polls). */
  entitlementSubscribe: "entitlement:subscribe",
  /** invoke: the live subscription summary `(→ SubscriptionInfo | null)` — plan badge + manage surface. */
  entitlementSubscription: "entitlement:subscription",
  /** invoke: preview a plan change `(priceId → PlanChangePreview)` — what Paddle charges/credits now. */
  entitlementPreviewChange: "entitlement:previewChange",
  /** invoke: apply a plan change `(priceId → SubscriptionInfo)` — prorated immediately. */
  entitlementChangePlan: "entitlement:changePlan",
  /** invoke: open a Paddle-HOSTED management page `("cancel" | "payment")` in the system browser. */
  entitlementOpenManage: "entitlement:openManage",
  /** push: the entitlement status changed, `(status)`. */
  entitlementStatusChanged: "entitlement:statusChanged",
  /** invoke: price a restore `({blobKeys, egressBytes} → RetrievalQuote)` — the ONLY honest restore price
   *  (root RETRIEVAL.md); never compute one in the renderer. */
  retrievalQuote: "retrieval:quote",
  /** invoke: pay for a quoted restore `(jobId → RetrievalQuote)`; resolves once the webhook confirms and
   *  the backend has thawed. Charges a saved card in place, or opens Paddle checkout in the browser. */
  retrievalPay: "retrieval:pay",
  /** invoke: poll one restore job `(jobId → RetrievalQuote)`. */
  retrievalJob: "retrieval:job",
  /** invoke: drop an unpaid quote `(jobId → void)` so it burns none of the free allowance. */
  retrievalCancel: "retrieval:cancel",
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
 * Storage entitlement (PROD.md "Free-tier entitlement flip") — the gate on DEPOSITS (browse/restore
 * stay open). `known` guards against gating before the first check lands (never block on a transient
 * unknown).
 *
 * **`quotaBytes` is the gate; `active` is only a UI signal.** Every signed-in account has a byte quota
 * — the free tier's 25 GB with no subscription, the plan's allowance with one — and backing up is
 * blocked only when the vault is FULL. `active` just picks which upsell that block shows (subscribe
 * vs. change plan). Not subscribing is not a reason to refuse a deposit.
 */
export interface EntitlementStatus {
  /** Whether entitlement has been fetched at least once for the signed-in user. */
  known: boolean;
  /** Has a paid subscription. NOT the deposit gate — display/upsell only (see above). */
  active: boolean;
  /** A checkout is open in the browser and we're polling for the webhook to flip `active`. */
  checkingOut: boolean;
  /** Byte cap on deposits: the free tier's, or the plan's. Null = unknown — fails OPEN (unlimited). */
  quotaBytes: number | null;
  error: string | null;
}

/**
 * A priced restore, straight from the backend's `POST /retrieval/quote` (root `RETRIEVAL.md`).
 *
 * THIS IS THE ONLY HONEST RESTORE PRICE — the one the card is actually charged. The daemon's local rate
 * card (`Pricing`) quotes raw AWS *thaw* rates and knows nothing about egress (36× bigger), Paddle's cut,
 * or this account's free allowance; using it for a restore figure understates the real charge by ~40×.
 * Never compute a restore cost in the renderer. Ask the backend, show what it says.
 */
export interface RetrievalQuote {
  jobId: string;
  /** `allowed` (free, already authorized) | `quoted` (needs payment) | `paid` | `canceled`. */
  status: string;
  /** Bytes that will come back to the user. */
  egressBytes: number;
  /** Bytes covered by the free monthly allowance — no charge. */
  allowanceBytes: number;
  /** Bytes the user pays for. Zero ⇒ this restore is free. */
  billableBytes: number;
  /** The charge, in whole US cents. Zero ⇒ free. */
  quoteCents: number;
  /** True once the backend has thawed (or is thawing) the blobs — the daemon may now proceed. */
  authorized: boolean;
  /** How long the thaw takes, in plain words ("~48 hours"). Comes from the BACKEND because the backend
   *  picks the retrieval tier — the app must never state a wait the backend didn't quote. */
  typicalWait: string;
}

/**
 * One sellable plan (a size × term cell of the backend's `GET /catalog`, PADDLE.md "Multi-plan
 * picker") — fetched live so the picker always sells exactly what the Paddle account defines.
 */
export interface CatalogPlan {
  /** Storage size label, e.g. "1 TB". */
  size: string;
  /** Term length in years — the subscription renews every N years (rate-lock, no discount). */
  years: number;
  priceId: string;
  /** Total for the whole term, in USD cents (what checkout charges). */
  amountCents: number;
  /** Server-derived per-month equivalent in cents — display only. */
  perMonthCents: number;
  /** Storage cap for this plan, in bytes (e.g. 500_000_000_000 for "500 GB"). */
  quotaBytes: number;
}

/**
 * The live subscription, summarized by the backend against the catalog (`GET /subscription`) —
 * what the sidebar plan badge and the Settings manage surface render. Null = never subscribed.
 */
export interface SubscriptionInfo {
  /** Paddle subscription status ("active", "paused", "past_due", …) — display only; the
   * deposit gate stays {@link EntitlementStatus} (the webhook-fed source of truth). */
  status: string;
  /** The catalog plan this subscription is on — null for an off-catalog (legacy) price. */
  plan: CatalogPlan | null;
  nextBilledAt: string | null;
  /** Set when a cancellation is scheduled — the ISO date the subscription ends. */
  cancelsAt: string | null;
}

/** What a plan change does to money RIGHT NOW (Paddle previewUpdate, prorated immediately). */
export interface PlanChangePreview {
  /** "charge" = pay the difference now; "credit" = balance applied to future bills. */
  action: "charge" | "credit";
  amountCents: number;
  currency: string;
  nextBilledAt: string | null;
}

/** The Paddle-hosted management pages the app can open (in the system browser). */
export type ManagePage = "cancel" | "payment";

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
  /** The sellable plan catalog for the subscribe picker, fetched live from the billing server.
   * Rejects when the server is unreachable — the picker shows a retryable error, never a stale list. */
  getPlanCatalog(): Promise<CatalogPlan[]>;
  /** Start a subscription checkout for the chosen plan: opens Paddle checkout in the system browser
   * and polls until the webhook marks the subscription active (watch {@link onEntitlement}).
   * Rejects if checkout can't start. */
  subscribe(priceId: string): Promise<void>;
  /** The live subscription summary — null when this account never subscribed. */
  getSubscription(): Promise<SubscriptionInfo | null>;
  /** Preview what changing to `priceId` charges (or credits) right now, before committing. */
  previewPlanChange(priceId: string): Promise<PlanChangePreview>;
  /** Change the subscription to `priceId` (prorated immediately). Resolves to the new summary. */
  changePlan(priceId: string): Promise<SubscriptionInfo>;
  /** Open a Paddle-hosted management page (cancel / update payment method) in the system browser. */
  openManage(page: ManagePage): Promise<void>;

  /* ── Paid retrieval (root RETRIEVAL.md) ─────────────────────────────────────────────────────────
   * The daemon reports `authorizationRequired` for a frozen blob it isn't allowed to thaw; these four
   * are how the app gets that restore authorized. */

  /** Price a restore of these blobs. `quoteCents: 0` + `authorized` ⇒ free under the monthly allowance,
   *  already thawing — nothing to confirm. This is the only trustworthy restore price; do not compute one
   *  from the daemon's rate card, which omits egress and understates the real charge by ~40×. */
  quoteRestore(blobKeys: string[], egressBytes: number): Promise<RetrievalQuote>;
  /** Pay for a quoted restore. Charges a saved card in place, or opens Paddle checkout in the browser;
   *  resolves once the payment is confirmed and the backend has begun thawing. */
  payForRestore(jobId: string): Promise<RetrievalQuote>;
  /** Poll one restore job. */
  getRestoreJob(jobId: string): Promise<RetrievalQuote>;
  /** Abandon an unpaid quote, so it burns none of the free allowance. */
  cancelRestore(jobId: string): Promise<void>;

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
