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
  type OAuthConfig,
  type TokenSet,
} from "./oauth.ts";
import { awaitLoopbackCallback, LOOPBACK_PORT } from "./loopback.ts";

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
  private readonly statusListeners = new Set<(s: AuthStatus) => void>();
  private readonly idTokenListeners = new Set<(idToken: string) => void>();

  constructor(cfg: OAuthConfig | null, opts: { useLoopback: boolean }) {
    this.cfg = cfg;
    this.useLoopback = opts.useLoopback;
  }

  /** Serializable snapshot for the renderer (pushed on every change; pulled once at first paint). */
  status(): AuthStatus {
    if (!this.cfg) return { configured: false, state: "signedOut", email: null, error: null };
    const state = this.tokens ? "signedIn" : this.pending ? "signingIn" : "signedOut";
    const email = this.tokens ? decodeJwtClaims(this.tokens.idToken)?.email : null;
    return { configured: true, state, email: typeof email === "string" ? email : null, error: this.lastError };
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
    if (!this.cfg) return;
    let raw: string;
    try {
      raw = await readFile(this.authFile(), "utf8");
    } catch {
      return; // no stored session
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const b64 = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).refreshToken : null;
      if (typeof b64 !== "string") throw new Error("malformed auth.json");
      const { result: refreshToken } = await safeStorage.decryptStringAsync(Buffer.from(b64, "base64"));
      await this.adopt(await refreshTokens(this.cfg, refreshToken));
    } catch (e) {
      console.error("stored sign-in couldn't be restored (starting signed out):", e);
      await rm(this.authFile(), { force: true });
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
          `often a VS Code forwarded port (Ports panel → remove it). Run: task ui:auth:doctor ` +
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

  /** Take a token set live: schedule its refresh, persist the refresh token, tell everyone. */
  private async adopt(t: TokenSet): Promise<void> {
    this.tokens = t;
    this.lastError = null;
    this.scheduleRefresh();
    await this.persistRefreshToken(t.refreshToken);
    this.emitStatus();
    for (const l of this.idTokenListeners) l(t.idToken);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.tokens?.refreshToken) return;
    const delay = Math.max(this.tokens.expiresAt - Date.now() - REFRESH_SKEW_MS, 30 * 1000);
    this.refreshTimer = setTimeout(() => void this.refreshNow(), delay);
  }

  /** Refresh the session. `invalid_grant` means the refresh token is dead (revoked/expired) — that's
   * a real sign-out; anything else (offline) keeps the session and retries shortly. */
  private async refreshNow(): Promise<void> {
    if (!this.cfg || !this.tokens?.refreshToken) return;
    try {
      await this.adopt(await refreshTokens(this.cfg, this.tokens.refreshToken));
    } catch (e) {
      if (e instanceof Error && e.message.includes("invalid_grant")) {
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

  /** Persist the refresh token encrypted-at-rest. If the Keychain-backed encryptor is unavailable we
   * store NOTHING (the session just won't survive relaunch) — never plaintext. */
  private async persistRefreshToken(refreshToken: string | null): Promise<void> {
    if (!refreshToken) return;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      console.error("safeStorage unavailable — sign-in won't survive a relaunch");
      return;
    }
    const encrypted = await safeStorage.encryptStringAsync(refreshToken);
    await writeFile(this.authFile(), `${JSON.stringify({ refreshToken: encrypted.toString("base64") })}\n`, { mode: 0o600 });
  }

  private emitStatus(): void {
    const s = this.status();
    for (const l of this.statusListeners) l(s);
  }
}
