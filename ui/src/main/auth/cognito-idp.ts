/**
 * Cognito user-pool API over plain HTTPS JSON-RPC (PROD.md Phase 5b-3) — the email-OTP passwordless
 * lane, the no-Google path. These are the pool's UNAUTHENTICATED public-client operations (SignUp /
 * ConfirmSignUp / InitiateAuth) plus session-authorized RespondToAuthChallenge, so NO AWS SDK and NO
 * SigV4 are needed: a POST to `cognito-idp.{region}.amazonaws.com` with an `X-Amz-Target` header. Our
 * app client has no secret, so there's no `SECRET_HASH` anywhere.
 *
 * Endpoint shapes verified against the current Cognito docs (2026-07-02). Pure fetch — no Electron — so
 * URL/body building + error mapping unit-test headless (cognito-idp.test.ts).
 */
import type { TokenSet } from "./oauth.ts";

/** A Cognito API error carrying its `__type` (e.g. `UserNotFoundException`, `CodeMismatchException`) so
 * callers can branch on it (new-user detection) or turn it into a friendly message. */
export class CognitoError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

/** Cognito's `AuthenticationResult` (the tokens), as returned by InitiateAuth/RespondToAuthChallenge. */
interface AuthenticationResult {
  AccessToken: string;
  IdToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}

const isAuthResult = (v: unknown): v is { AuthenticationResult: AuthenticationResult } => {
  if (typeof v !== "object" || v === null) return false;
  const r = (v as Record<string, unknown>).AuthenticationResult;
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.IdToken === "string" && typeof o.AccessToken === "string" && typeof o.ExpiresIn === "number";
};

/** Map a Cognito `AuthenticationResult` to the app's TokenSet. `previousRefreshToken` is kept when the
 * response omits one (REFRESH_TOKEN_AUTH doesn't reissue it), mirroring the OAuth refresh path. */
const toTokenSet = (r: AuthenticationResult, previousRefreshToken: string | null): TokenSet => ({
  idToken: r.IdToken,
  accessToken: r.AccessToken,
  refreshToken: r.RefreshToken ?? previousRefreshToken,
  expiresAt: Date.now() + r.ExpiresIn * 1000,
  lane: "email",
});

/** One JSON-RPC call. Throws {@link CognitoError} on any non-2xx (Cognito returns HTTP 400 +
 * `{"__type": "...", "message": "..."}`) or a network/timeout failure. */
const call = async (region: string, target: string, body: unknown): Promise<Record<string, unknown>> => {
  let res: Response;
  try {
    res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CognitoError("NetworkError", e instanceof DOMException && e.name === "TimeoutError" ? "the server didn't respond in time" : "couldn't reach the sign-in server");
  }
  const json: unknown = await res.json().catch(() => null);
  const o = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  if (!res.ok) {
    // __type is like "com.amazon...#UserNotFoundException" — keep only the exception name.
    const type = typeof o.__type === "string" ? o.__type.split("#").pop() ?? o.__type : `Http${res.status}`;
    throw new CognitoError(type, typeof o.message === "string" ? o.message : `request failed (${res.status})`);
  }
  return o;
};

export interface Cognito {
  region: string;
  clientId: string;
}

/** A pending email-OTP flow: the challenge Session + whether the user is signing IN (existing) or the
 * account was just created (signup, whose emailed code is a confirmation, not a challenge answer). */
export interface EmailFlow {
  email: string;
  session: string;
  mode: "signin" | "signup";
}

/**
 * Begin email sign-in. Tries the existing-user path (InitiateAuth EMAIL_OTP); on `UserNotFoundException`
 * falls through to self-service signup (SignUp with no password). Either way a code is emailed and an
 * {@link EmailFlow} is returned to carry into {@link submitEmailCode}. The two paths are indistinguishable
 * to the user — "we emailed you a code".
 */
export const startEmailSignIn = async (c: Cognito, email: string): Promise<EmailFlow> => {
  try {
    return { email, session: await initiateEmailOtp(c, email), mode: "signin" };
  } catch (e) {
    if (e instanceof CognitoError && e.type === "UserNotFoundException") {
      try {
        return { email, session: await signUp(c, email), mode: "signup" };
      } catch (e2) {
        // The pre-sign-up trigger refused this signup (one email = one account: the address belongs
        // to a legacy unlinked Google account). Cognito wraps the trigger's message — unwrap it so
        // the user reads "This email signs in with Google — use Continue with Google", not plumbing.
        if (e2 instanceof CognitoError && e2.type === "UserLambdaValidationException") {
          throw new CognitoError(e2.type, stripLambdaWrapper(e2.message));
        }
        throw e2;
      }
    }
    throw e;
  }
};

/** "PreSignUp failed with error <msg>." → "<msg>" — Cognito's trigger-error wrapper, removed at the
 * one place it reaches the user. Exported for its unit test. */
export const stripLambdaWrapper = (message: string): string => {
  const m = /^PreSignUp failed with error (.*?)\.?$/.exec(message.trim());
  return m?.[1] ? m[1] : message;
};

/** Finish an email-OTP flow with the code the user typed → tokens. Signin answers the EMAIL_OTP
 * challenge; signup confirms the account then signs in directly from that confirmation session. */
export const submitEmailCode = async (c: Cognito, flow: EmailFlow, code: string): Promise<TokenSet> => {
  const trimmed = code.trim();
  if (flow.mode === "signin") {
    return respondEmailOtp(c, flow.email, flow.session, trimmed);
  }
  const session = await confirmSignUp(c, flow.email, trimmed, flow.session);
  return initiateAuthFromSession(c, flow.email, session);
};

/** Refresh email-lane tokens. API-lane refresh is InitiateAuth REFRESH_TOKEN_AUTH (NOT the OAuth
 * /oauth2/token endpoint, which is for the managed-login lane) — it returns fresh id/access tokens and
 * no new refresh token, so the caller keeps the existing one. */
export const refreshEmailTokens = async (c: Cognito, refreshToken: string): Promise<TokenSet> => {
  const r = await call(c.region, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: c.clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  if (!isAuthResult(r)) throw new CognitoError("BadResponse", "refresh returned no tokens");
  return toTokenSet(r.AuthenticationResult, refreshToken);
};

// ── internals ──────────────────────────────────────────────────────────────────────────────────────

/** InitiateAuth USER_AUTH, asking for EMAIL_OTP up front. Returns the challenge Session (code emailed).
 * If the pool answers with SELECT_CHALLENGE instead of EMAIL_OTP, pick EMAIL_OTP to trigger the send. */
const initiateEmailOtp = async (c: Cognito, email: string): Promise<string> => {
  const r = await call(c.region, "InitiateAuth", {
    AuthFlow: "USER_AUTH",
    ClientId: c.clientId,
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" },
  });
  if (r.ChallengeName === "EMAIL_OTP") return requireSession(r);
  if (r.ChallengeName === "SELECT_CHALLENGE") {
    const sel = await call(c.region, "RespondToAuthChallenge", {
      ChallengeName: "SELECT_CHALLENGE",
      ClientId: c.clientId,
      Session: requireSession(r),
      ChallengeResponses: { USERNAME: email, ANSWER: "EMAIL_OTP" },
    });
    return requireSession(sel);
  }
  throw new CognitoError("UnexpectedChallenge", `sign-in returned an unexpected challenge (${String(r.ChallengeName)})`);
};

const respondEmailOtp = async (c: Cognito, email: string, session: string, code: string): Promise<TokenSet> => {
  const r = await call(c.region, "RespondToAuthChallenge", {
    ChallengeName: "EMAIL_OTP",
    ClientId: c.clientId,
    Session: session,
    ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code },
  });
  if (!isAuthResult(r)) throw new CognitoError("BadResponse", "the code was accepted but no tokens came back");
  return toTokenSet(r.AuthenticationResult, null);
};

/** Passwordless SignUp (no Password) — first-class for a passwordless pool. Emails a verification code
 * and returns the Session that ConfirmSignUp continues. */
const signUp = async (c: Cognito, email: string): Promise<string> => {
  const r = await call(c.region, "SignUp", {
    ClientId: c.clientId,
    Username: email,
    UserAttributes: [{ Name: "email", Value: email }],
  });
  return requireSession(r);
};

const confirmSignUp = async (c: Cognito, email: string, code: string, session: string): Promise<string> => {
  const r = await call(c.region, "ConfirmSignUp", {
    ClientId: c.clientId,
    Username: email,
    ConfirmationCode: code,
    Session: session,
  });
  return requireSession(r);
};

/** Sign in directly from a ConfirmSignUp session — Cognito treats the just-used confirmation code as the
 * first auth factor, so no second code is needed. Returns tokens. */
const initiateAuthFromSession = async (c: Cognito, email: string, session: string): Promise<TokenSet> => {
  const r = await call(c.region, "InitiateAuth", {
    AuthFlow: "USER_AUTH",
    ClientId: c.clientId,
    Session: session,
    AuthParameters: { USERNAME: email },
  });
  if (!isAuthResult(r)) throw new CognitoError("BadResponse", "sign-up completed but no tokens came back");
  return toTokenSet(r.AuthenticationResult, null);
};

const requireSession = (r: Record<string, unknown>): string => {
  if (typeof r.Session !== "string") throw new CognitoError("BadResponse", "the sign-in server returned no session to continue");
  return r.Session;
};
