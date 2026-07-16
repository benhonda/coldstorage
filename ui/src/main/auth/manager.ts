/**
 * Main-process sign-in state machine (PROD.md Phase 5). Owns the OAuth flow end-to-end: opens the
 * system browser at Cognito managed login (Google — the email-code lane lands with 5b), receives the
 * redirect (packaged: the `coldstorage://` deep link routed in from index.ts; dev: the loopback
 * listener), exchanges the code (PKCE), and keeps the session alive by refreshing ahead of expiry.
 *
 * Token custody: access/ID tokens live in main-process MEMORY only. The refresh token alone is
 * persisted, encrypted via safeStorage (Keychain-backed key) in `userData/auth.json`. The renderer
 * never sees any token — it gets {@link AuthStatus} pushes and calls signIn/signOut over IPC. The
 * ID token's one consumer in-process is the daemon handoff (index.ts → `authenticate`).
 */
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { app, safeStorage, shell } from "electron";
import type { AuthStatus } from "../../shared/ipc.ts";
import { createPkce } from "./pkce.ts";
import {
  buildAuthorizeUrl,
  decodeJwtClaims,
  exchangeCode,
  parseCallbackUrl,
  refreshTokens,
  revokeRefreshToken,
  type AuthLane,
  type OAuthConfig,
  type TokenSet,
} from "./oauth.ts";
import { awaitLoopbackCallback, LOOPBACK_PORT } from "./loopback.ts";
import {
  refreshEmailTokens,
  startEmailSignIn as apiStartEmailSignIn,
  submitEmailCode as apiSubmitEmailCode,
  type Cognito,
  type EmailFlow,
} from "./cognito-idp.ts";

/** Refresh this far before token expiry (tokens live 1h — cognito.tf `id_token_validity`). */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** A pending attempt dies with its authorization code (Cognito: 5-minute, single-use). */
const PENDING_TTL_MS = 5 * 60 * 1000;
/** Retry cadence after a refresh that failed for a non-auth reason (offline laptop, DNS blip). */
const REFRESH_RETRY_MS = 60 * 1000;

/** One in-flight sign-in attempt, keyed by its `state` nonce. */
interface PendingSignIn {
  state: string;
  verifier: string;
  expiresAt: number;
  stopLoopback: (() => void) | null;
}

export class AuthManager {
  /** Null = sign-in not configured (dogfood mode) — every entry point no-ops and status says so. */
  private readonly cfg: OAuthConfig | null;
  /** Dev mode listens on the loopback; packaged relies on the deep link. */
  private readonly useLoopback: boolean;
  private tokens: TokenSet | null = null;
  private pending: PendingSignIn | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  /** False until {@link restore} finishes checking for a saved session — status reports `restoring`
   * meanwhile so the UI shows "checking…" instead of flashing the login screen at a returning user. */
  private settled = false;
  /** The in-flight email-OTP flow between {@link startEmailSignIn} and {@link submitEmailCode}. */
  private emailFlow: EmailFlow | null = null;
  private readonly statusListeners = new Set<(s: AuthStatus) => void>();
  private readonly idTokenListeners = new Set<(idToken: string) => void>();

  constructor(cfg: OAuthConfig | null, opts: { useLoopback: boolean }) {
    this.cfg = cfg;
    this.useLoopback = opts.useLoopback;
  }

  /** Serializable snapshot for the renderer (pushed on every change; pulled once at first paint). */
  status(): AuthStatus {
    if (!this.cfg) return { configured: false, state: "signedOut", email: null, name: null, error: null, emailAvailable: false };
    const emailAvailable = this.emailAvailable();
    // Still checking a saved session — don't reveal signed-in/out yet (that's the login-flash).
    if (!this.settled) return { configured: true, state: "restoring", email: null, name: null, error: null, emailAvailable };
    const state = this.tokens ? "signedIn" : this.pending ? "signingIn" : "signedOut";
    const claims = this.tokens ? decodeJwtClaims(this.tokens.idToken) : null;
    const email = claims?.email;
    // Google lane only (the IdP attribute mapping) — the onboarding name-step prefill, nothing more.
    const name = claims?.name;
    return {
      configured: true,
      state,
      email: typeof email === "string" ? email : null,
      name: typeof name === "string" ? name : null,
      error: this.lastError,
      emailAvailable,
    };
  }

  /** Subscribe to status changes. Returns an unsubscribe fn. */
  onStatus(listener: (s: AuthStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Fires with every freshly-minted ID token (sign-in AND background refresh) — the daemon handoff
   * re-runs `authenticate` on each so its Cognito logins never go stale. */
  onIdToken(listener: (idToken: string) => void): () => void {
    this.idTokenListeners.add(listener);
    return () => this.idTokenListeners.delete(listener);
  }

  /** Silent session restore at launch: decrypt the stored refresh token, refresh. Only callable
   * after `ready` (safeStorage needs the Keychain). No stored session is a normal signed-out start;
   * an unusable one (revoked, undecryptable after a signing-identity change) is dropped so we don't
   * retry forever. */
  async restore(): Promise<void> {
    // `settled` MUST flip in every exit path (no session / restored / failed / dogfood) — until it does,
    // status() reports `restoring` and the UI holds on "checking…". The finally guarantees it.
    try {
      if (!this.cfg) return;
      let raw: string;
      try {
        raw = await readFile(this.authFile(), "utf8");
      } catch {
        return; // no stored session
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const o = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        if (typeof o.refreshToken !== "string") throw new Error("malformed auth.json");
        // Refresh via the lane that minted the session. Older sessions (pre-5b-3) have no `lane` → OAuth.
        const lane: AuthLane = o.lane === "email" ? "email" : "oauth";
        const { result: refreshToken } = await safeStorage.decryptStringAsync(Buffer.from(o.refreshToken, "base64"));
        if (lane === "email") {
          const c = this.cognito();
          if (!c) throw new Error("email lane not configured");
          await this.adopt(await refreshEmailTokens(c, refreshToken));
        } else {
          await this.adopt(await refreshTokens(this.cfg, refreshToken));
        }
      } catch (e) {
        console.error("stored sign-in couldn't be restored (starting signed out):", e);
        await rm(this.authFile(), { force: true });
      }
    } finally {
      this.settled = true;
      this.emitStatus();
    }
  }

  /** Start (or restart — a new attempt supersedes a stuck one) a sign-in: fresh PKCE material, then
   * the system browser at managed login. The flow completes asynchronously in handleCallbackUrl. */
  async signIn(): Promise<void> {
    if (!this.cfg) return;
    this.clearPending();
    const { verifier, challenge, state } = createPkce();
    const pending: PendingSignIn = { state, verifier, expiresAt: Date.now() + PENDING_TTL_MS, stopLoopback: null };
    if (this.useLoopback) {
      // Bind BEFORE opening the browser — an unbindable port must fail here, visibly, not as a
      // browser redirect hanging against whatever process owns it (see loopback.ts).
      const { stop, ready } = awaitLoopbackCallback((url) => void this.handleCallbackUrl(url));
      pending.stopLoopback = stop;
      try {
        await ready;
      } catch (e) {
        stop();
        this.pending = null;
        this.lastError =
          `port ${LOOPBACK_PORT} is taken on this Mac, so the sign-in redirect can't come back — ` +
          `often a VS Code forwarded port (Ports panel → remove it). Run: task ui:mac:auth:doctor ` +
          `(${e instanceof Error ? e.message : String(e)})`;
        this.emitStatus();
        return;
      }
    }
    this.pending = pending;
    this.lastError = null;
    this.emitStatus();
    await shell.openExternal(buildAuthorizeUrl(this.cfg, { state, challenge, identityProvider: "Google" }));
  }

  /** Whether the email-OTP lane is available (region resolved) — the UI hides the email option if not. */
  emailAvailable(): boolean {
    return this.cognito() !== null;
  }

  /**
   * Email-OTP lane (5b-3), step 1: email a one-time code. Handles both existing users (sign-in) and new
   * ones (self-service signup) transparently — the caller just shows a "we emailed you a code" screen.
   * Rejects (with a user-facing message) on a bad email / server error. The code entry is in-app, so
   * this doesn't touch the global sign-in status the way the browser (Google) flow does.
   */
  async startEmailSignIn(email: string): Promise<void> {
    const c = this.cognito();
    if (!c) throw new Error("Email sign-in isn't available.");
    this.emailFlow = await apiStartEmailSignIn(c, email.trim().toLowerCase());
  }

  /** Email-OTP lane, step 2: exchange the code for tokens and go live (same machinery as Google — the
   * daemon handoff + vault provisioning follow from the emitted ID token). Rejects on a wrong/expired code. */
  async submitEmailCode(code: string): Promise<void> {
    const c = this.cognito();
    if (!c || !this.emailFlow) throw new Error("No email sign-in is in progress.");
    await this.adopt(await apiSubmitEmailCode(c, this.emailFlow, code));
  }

  /** Abandon an in-progress email flow (the user backed out to pick Google instead). */
  cancelEmailSignIn(): void {
    this.emailFlow = null;
  }

  /**
   * A redirect arrived (deep link or loopback). Returns false iff the URL isn't a sign-in callback
   * at all (so index.ts can route other future deep links). Callbacks whose `state` doesn't match
   * the live pending attempt are dropped silently — that's the duplicate-open-url guard AND the
   * CSRF guard in one.
   */
  async handleCallbackUrl(raw: string): Promise<boolean> {
    const parsed = parseCallbackUrl(raw);
    if (parsed === null) return false;
    if (!this.cfg) return true;

    const pending = this.pending;
    if (parsed.kind === "error") {
      // The IdP said no (user cancelled at Google, mostly). Only unwind OUR pending attempt.
      if (pending && parsed.state === pending.state) {
        this.clearPending();
        this.lastError = parsed.error === "access_denied" ? null : (parsed.description ?? parsed.error);
        this.emitStatus();
      }
      return true;
    }
    if (!pending || parsed.state !== pending.state || pending.expiresAt < Date.now()) return true;

    this.clearPending();
    try {
      await this.adopt(await exchangeCode(this.cfg, parsed.code, pending.verifier));
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emitStatus();
    }
    return true;
  }

  /** The current ID token, refreshed first if it's within 2 minutes of expiry — for consumers that
   * need it valid NOW (the daemon handoff on reconnect). Null when signed out. */
  async getFreshIdToken(): Promise<string | null> {
    if (!this.cfg || !this.tokens) return null;
    if (this.tokens.expiresAt - Date.now() > 2 * 60 * 1000) return this.tokens.idToken;
    if (this.tokens.refreshToken) await this.refreshNow();
    return this.tokens?.idToken ?? null;
  }

  /** Sign out: drop local state + the stored session first (always succeeds), then best-effort
   * revoke the refresh token server-side (kills derived tokens too). NOTE the daemon keeps its
   * short-lived STS creds until they expire (~1h) — a daemon-side sign-out command rides with 5b. */
  async signOut(): Promise<void> {
    if (!this.cfg) return;
    const refreshToken = this.tokens?.refreshToken ?? null;
    this.clearPending();
    this.tokens = null;
    this.lastError = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await rm(this.authFile(), { force: true });
    this.emitStatus();
    if (refreshToken) {
      try {
        await revokeRefreshToken(this.cfg, refreshToken);
      } catch (e) {
        console.error("token revoke failed (already signed out locally):", e);
      }
    }
  }

  /** Detach timers/listeners at quit. */
  dispose(): void {
    this.clearPending();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.statusListeners.clear();
    this.idTokenListeners.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  private authFile(): string {
    return join(app.getPath("userData"), "auth.json");
  }

  private clearPending(): void {
    this.pending?.stopLoopback?.();
    this.pending = null;
  }

  /** Take a token set live: schedule its refresh, persist the refresh token + lane, tell everyone. */
  private async adopt(t: TokenSet): Promise<void> {
    this.tokens = t;
    this.lastError = null;
    this.emailFlow = null;
    this.scheduleRefresh();
    await this.persistRefreshToken(t.refreshToken, t.lane);
    this.emitStatus();
    for (const l of this.idTokenListeners) l(t.idToken);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.tokens?.refreshToken) return;
    const delay = Math.max(this.tokens.expiresAt - Date.now() - REFRESH_SKEW_MS, 30 * 1000);
    this.refreshTimer = setTimeout(() => void this.refreshNow(), delay);
  }

  /** The email-OTP lane's cognito-idp coordinates (region + client id), or null if the region couldn't
   * be resolved (non-standard domain) — in which case email sign-in is unavailable. */
  private cognito(): Cognito | null {
    if (!this.cfg || !this.cfg.region) return null;
    return { region: this.cfg.region, clientId: this.cfg.clientId };
  }

  /** Refresh via the lane that minted the session: OAuth (Google) at `/oauth2/token`, email (Cognito
   * API OTP) at InitiateAuth REFRESH_TOKEN_AUTH — the two use different endpoints. */
  private refreshForLane(refreshToken: string): Promise<TokenSet> {
    if (this.tokens?.lane === "email") {
      const c = this.cognito();
      if (!c) throw new Error("email lane not configured");
      return refreshEmailTokens(c, refreshToken);
    }
    // cfg is non-null here (checked by callers); OAuth lane.
    return refreshTokens(this.cfg as OAuthConfig, refreshToken);
  }

  /** Refresh the session. A rejected refresh token (`invalid_grant` on OAuth, `NotAuthorized`/expired on
   * the email lane) means the session is dead → sign out; anything else (offline) keeps it and retries. */
  private async refreshNow(): Promise<void> {
    if (!this.cfg || !this.tokens?.refreshToken) return;
    try {
      await this.adopt(await this.refreshForLane(this.tokens.refreshToken));
    } catch (e) {
      const dead = e instanceof Error && (e.message.includes("invalid_grant") || e.message.includes("NotAuthorized"));
      if (dead) {
        console.error("session expired (refresh token rejected) — signing out");
        this.tokens = null;
        await rm(this.authFile(), { force: true });
        this.emitStatus();
        return;
      }
      console.error(`token refresh failed, retrying in ${REFRESH_RETRY_MS / 1000}s:`, e);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => void this.refreshNow(), REFRESH_RETRY_MS);
    }
  }

  /** Persist the refresh token (encrypted-at-rest) + its lane, so a restored session refreshes at the
   * right endpoint. If the Keychain-backed encryptor is unavailable we store NOTHING (the session just
   * won't survive relaunch) — never plaintext. */
  private async persistRefreshToken(refreshToken: string | null, lane: AuthLane): Promise<void> {
    if (!refreshToken) return;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      console.error("safeStorage unavailable — sign-in won't survive a relaunch");
      return;
    }
    const encrypted = await safeStorage.encryptStringAsync(refreshToken);
    await writeFile(this.authFile(), `${JSON.stringify({ refreshToken: encrypted.toString("base64"), lane })}\n`, { mode: 0o600 });
  }

  private emitStatus(): void {
    const s = this.status();
    for (const l of this.statusListeners) l(s);
  }
}
