/**
 * Cognito managed-login OAuth wire helpers: authorization-code + PKCE for a PUBLIC client (a desktop
 * app can't keep a secret — `client_id` goes in the token body, no Authorization header). Endpoint
 * shapes verified against the Cognito docs 2026-07-02 (PROD.md Phase 5).
 *
 * Pure URL/fetch code — no Electron — so building/parsing unit-tests headless (oauth.test.ts).
 * Token VERIFICATION deliberately does not happen here: the daemon (Identity Pool) and the account
 * backend (aws-jwt-verify) each verify the ID token themselves; the app only transports it.
 */

export interface OAuthConfig {
  /** Managed-login host, e.g. `coldstorage-production-….auth.ca-central-1.amazoncognito.com`. */
  domain: string;
  /** The desktop app client id (public — cognito.tf `aws_cognito_user_pool_client.app`). */
  clientId: string;
  /** Must byte-match a registered callback URL (cognito.tf `app_oauth_callback_urls`). */
  redirectUri: string;
}

/** Tokens as the app holds them — absolute expiry (ms epoch), not the wire's relative `expires_in`.
 * Access/ID tokens live in main-process memory only; the refresh token alone is persisted (encrypted). */
export interface TokenSet {
  idToken: string;
  accessToken: string;
  /** Null only if Cognito ever omits it (refresh without rotation returns none — we keep the old one). */
  refreshToken: string | null;
  expiresAt: number;
}

/** A parsed sign-in redirect: success carries the code, failure the IdP's error (e.g. the user
 * cancelled at Google). Both carry `state` for matching against the pending attempt. */
export type CallbackResult =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string | null; state: string | null };

/** The two redirect shapes we register: the packaged app's custom scheme and the dev loopback. */
export const SCHEME_REDIRECT_URI = "coldstorage://auth/callback";

/** True if `raw` is a sign-in redirect (either shape). Other deep links (future `coldstorage://…`
 * routes) parse to null and are ignored by the auth layer. */
export const parseCallbackUrl = (raw: string): CallbackResult | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // coldstorage://auth/callback → host "auth" + path "/callback"; loopback → path "/auth/callback".
  const isScheme = url.protocol === "coldstorage:" && url.host === "auth" && url.pathname === "/callback";
  const isLoopback = (url.protocol === "http:" || url.protocol === "https:") && url.pathname === "/auth/callback";
  if (!isScheme && !isLoopback) return null;

  const error = url.searchParams.get("error");
  if (error !== null) {
    return { kind: "error", error, description: url.searchParams.get("error_description"), state: url.searchParams.get("state") };
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) {
    return { kind: "error", error: "invalid_callback", description: "redirect carried no code/state", state };
  }
  return { kind: "code", code, state };
};

/** The /oauth2/authorize URL to open in the SYSTEM browser (Google blocks embedded webviews).
 * `identityProvider: "Google"` skips the managed-login chooser and goes straight to Google. */
export const buildAuthorizeUrl = (
  cfg: OAuthConfig,
  opts: { state: string; challenge: string; identityProvider?: string },
): string => {
  const url = new URL(`https://${cfg.domain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    state: opts.state,
    code_challenge_method: "S256",
    code_challenge: opts.challenge,
    ...(opts.identityProvider ? { identity_provider: opts.identityProvider } : {}),
  }).toString();
  return url.toString();
};

/** Wire response of /oauth2/token (success). */
interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

const isTokenResponse = (v: unknown): v is TokenResponse => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id_token === "string" && typeof o.access_token === "string" && typeof o.expires_in === "number";
};

/** POST /oauth2/token (form-urlencoded). Cognito returns OAuth-style `{"error": "invalid_grant"}`
 * bodies with HTTP 400 — surfaced in the thrown message so callers can tell a revoked session
 * (invalid_grant → sign out) from a network blip (retry). */
const requestTokens = async (cfg: OAuthConfig, params: Record<string, string>): Promise<TokenSet> => {
  const res = await fetch(`https://${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isTokenResponse(body)) {
    const detail =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).error === "string"
        ? String((body as Record<string, unknown>).error)
        : `http ${res.status}`;
    throw new Error(`token request failed: ${detail}`);
  }
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
};

/** Redeem the authorization code from the callback (single-use, 5-minute validity). */
export const exchangeCode = (cfg: OAuthConfig, code: string, verifier: string): Promise<TokenSet> =>
  requestTokens(cfg, {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri,
  });

/** Mint fresh id/access tokens. Without rotation Cognito returns no new refresh token — keep the old
 * one so the session survives. (With rotation enabled later, the returned one simply wins.) */
export const refreshTokens = async (cfg: OAuthConfig, refreshToken: string): Promise<TokenSet> => {
  const t = await requestTokens(cfg, { grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: refreshToken });
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
};

/** POST /oauth2/revoke — kills the refresh token AND every access/ID token derived from it. */
export const revokeRefreshToken = async (cfg: OAuthConfig, refreshToken: string): Promise<void> => {
  const res = await fetch(`https://${cfg.domain}/oauth2/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken, client_id: cfg.clientId }).toString(),
  });
  if (!res.ok) throw new Error(`revoke failed: http ${res.status}`);
};

/** Decode a JWT payload WITHOUT verification — display-only claims (the signed-in email). Real
 * verification happens where the token is consumed (daemon → Identity Pool, backend → JWKS). */
export const decodeJwtClaims = (jwt: string): Record<string, unknown> | null => {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
