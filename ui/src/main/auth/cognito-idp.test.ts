/** Cognito email-OTP JSON-RPC — request shapes, token mapping, error/new-user branching (mocked fetch). */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { CognitoError, refreshEmailTokens, startEmailSignIn, stripLambdaWrapper, submitEmailCode, type EmailFlow } from "./cognito-idp.ts";

const C = { region: "ca-central-1", clientId: "client123" };

// Reassigning globalThis.fetch isn't undone by mock.restore() — capture + restore it ourselves so we
// don't leak the mock into other test files (e.g. loopback.test.ts, which uses the real fetch).
const realFetch = globalThis.fetch;

interface Call {
  target: string;
  body: Record<string, unknown>;
}

/** Install a fetch that answers each POST from a queue of responses (by call order), recording requests. */
const mockFetch = (responses: Array<{ ok?: boolean; status?: number; json: unknown }>): Call[] => {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    const target = String((init.headers as Record<string, string>)["X-Amz-Target"]).split(".").pop() ?? "";
    calls.push({ target, body: JSON.parse(String(init.body)) });
    const r = responses[i++] ?? { json: {} };
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.json),
    } as Response);
  }) as unknown as typeof fetch;
  return calls;
};

const authResult = { AuthenticationResult: { IdToken: "id", AccessToken: "ac", RefreshToken: "rt", ExpiresIn: 3600 } };

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe("startEmailSignIn", () => {
  test("existing user → InitiateAuth EMAIL_OTP, returns a signin flow", async () => {
    const calls = mockFetch([{ json: { ChallengeName: "EMAIL_OTP", Session: "sess-1" } }]);
    const flow = await startEmailSignIn(C, "ben@example.com");
    expect(flow).toEqual({ email: "ben@example.com", session: "sess-1", mode: "signin" });
    expect(calls[0]?.target).toBe("InitiateAuth");
    expect(calls[0]?.body).toMatchObject({
      AuthFlow: "USER_AUTH",
      ClientId: "client123",
      AuthParameters: { USERNAME: "ben@example.com", PREFERRED_CHALLENGE: "EMAIL_OTP" },
    });
  });

  test("unknown user → falls through to SignUp (no password), returns a signup flow", async () => {
    const calls = mockFetch([
      { ok: false, status: 400, json: { __type: "com.amazonaws#UserNotFoundException", message: "no such user" } },
      { json: { Session: "sess-signup" } },
    ]);
    const flow = await startEmailSignIn(C, "new@example.com");
    expect(flow.mode).toBe("signup");
    expect(flow.session).toBe("sess-signup");
    expect(calls[1]?.target).toBe("SignUp");
    expect(calls[1]?.body).toMatchObject({ ClientId: "client123", Username: "new@example.com" });
    // No password field on a passwordless SignUp.
    expect(calls[1]?.body).not.toHaveProperty("Password");
  });

  test("a non-UserNotFound error propagates (not swallowed as signup)", async () => {
    mockFetch([{ ok: false, status: 400, json: { __type: "InvalidParameterException", message: "bad email" } }]);
    await expect(startEmailSignIn(C, "bad")).rejects.toBeInstanceOf(CognitoError);
  });

  test("a pre-sign-up-blocked signup surfaces the trigger's message, unwrapped", async () => {
    // One email = one account: the trigger refuses a native signup against a legacy unlinked Google
    // account; Cognito wraps its message in "PreSignUp failed with error …".
    mockFetch([
      { ok: false, status: 400, json: { __type: "com.amazonaws#UserNotFoundException", message: "no such user" } },
      {
        ok: false,
        status: 400,
        json: {
          __type: "com.amazonaws#UserLambdaValidationException",
          message: "PreSignUp failed with error This email signs in with Google — use Continue with Google..",
        },
      },
    ]);
    await expect(startEmailSignIn(C, "ben@gmail.com")).rejects.toThrow(
      "This email signs in with Google — use Continue with Google.",
    );
  });
});

describe("stripLambdaWrapper", () => {
  test("unwraps Cognito's trigger-error prefix and its appended period", () => {
    expect(stripLambdaWrapper("PreSignUp failed with error Use Google instead..")).toBe("Use Google instead.");
    expect(stripLambdaWrapper("PreSignUp failed with error Use Google instead")).toBe("Use Google instead");
  });

  test("leaves an unwrapped message untouched", () => {
    expect(stripLambdaWrapper("some other failure")).toBe("some other failure");
  });
});

describe("submitEmailCode", () => {
  test("signin → RespondToAuthChallenge EMAIL_OTP, maps tokens", async () => {
    const calls = mockFetch([{ json: authResult }]);
    const flow: EmailFlow = { email: "ben@example.com", session: "sess-1", mode: "signin" };
    const tokens = await submitEmailCode(C, flow, "  12345678 ");
    expect(calls[0]?.target).toBe("RespondToAuthChallenge");
    expect(calls[0]?.body).toMatchObject({
      ChallengeName: "EMAIL_OTP",
      Session: "sess-1",
      ChallengeResponses: { USERNAME: "ben@example.com", EMAIL_OTP_CODE: "12345678" }, // trimmed
    });
    expect(tokens).toMatchObject({ idToken: "id", accessToken: "ac", refreshToken: "rt", lane: "email" });
    expect(tokens.expiresAt).toBeGreaterThan(0);
  });

  test("signup → ConfirmSignUp then InitiateAuth-from-session", async () => {
    const calls = mockFetch([{ json: { Session: "sess-confirmed" } }, { json: authResult }]);
    const flow: EmailFlow = { email: "new@example.com", session: "sess-signup", mode: "signup" };
    const tokens = await submitEmailCode(C, flow, "87654321");
    expect(calls[0]?.target).toBe("ConfirmSignUp");
    expect(calls[0]?.body).toMatchObject({ ConfirmationCode: "87654321", Session: "sess-signup" });
    expect(calls[1]?.target).toBe("InitiateAuth");
    expect(calls[1]?.body).toMatchObject({ AuthFlow: "USER_AUTH", Session: "sess-confirmed" });
    expect(tokens.lane).toBe("email");
  });

  test("wrong code → CognitoError surfaced", async () => {
    mockFetch([{ ok: false, status: 400, json: { __type: "CodeMismatchException", message: "wrong code" } }]);
    const flow: EmailFlow = { email: "ben@example.com", session: "s", mode: "signin" };
    await expect(submitEmailCode(C, flow, "0000")).rejects.toMatchObject({ type: "CodeMismatchException" });
  });
});

describe("refreshEmailTokens", () => {
  test("InitiateAuth REFRESH_TOKEN_AUTH, keeps the existing refresh token when none returned", async () => {
    const calls = mockFetch([{ json: { AuthenticationResult: { IdToken: "id2", AccessToken: "ac2", ExpiresIn: 3600 } } }]);
    const tokens = await refreshEmailTokens(C, "old-rt");
    expect(calls[0]?.body).toMatchObject({ AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: "old-rt" } });
    expect(tokens.refreshToken).toBe("old-rt"); // reused — REFRESH_TOKEN_AUTH doesn't reissue it
    expect(tokens.idToken).toBe("id2");
  });
});
