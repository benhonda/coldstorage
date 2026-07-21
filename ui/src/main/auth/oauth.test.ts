/** OAuth URL building/parsing — the pure halves of the sign-in flow (no fetch, no Electron). */
import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl, decodeJwtClaims, isFirstLinkError, parseCallbackUrl, SCHEME_REDIRECT_URI, schemeRedirectUri, type OAuthConfig } from "./oauth.ts";

const cfg: OAuthConfig = {
  domain: "example.auth.ca-central-1.amazoncognito.com",
  clientId: "client123",
  redirectUri: SCHEME_REDIRECT_URI,
};

describe("buildAuthorizeUrl", () => {
  test("carries the full PKCE + Google param set the Cognito authorize endpoint expects", () => {
    const url = new URL(buildAuthorizeUrl(cfg, { state: "st4te", challenge: "ch4llenge", identityProvider: "Google" }));
    expect(url.origin).toBe("https://example.auth.ca-central-1.amazoncognito.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client123",
      redirect_uri: "coldstorage://auth/callback",
      scope: "openid email profile",
      state: "st4te",
      code_challenge_method: "S256",
      code_challenge: "ch4llenge",
      identity_provider: "Google",
    });
  });

  test("omits identity_provider when unset (managed-login chooser — the 5b email lane)", () => {
    const url = new URL(buildAuthorizeUrl(cfg, { state: "s", challenge: "c" }));
    expect(url.searchParams.has("identity_provider")).toBe(false);
  });
});

describe("parseCallbackUrl", () => {
  test("parses the packaged deep-link shape", () => {
    expect(parseCallbackUrl("coldstorage://auth/callback?code=abc&state=xyz")).toEqual({
      kind: "code",
      code: "abc",
      state: "xyz",
    });
  });

  test("parses a staging-lane deep link — its own scheme routes back to the staging install", () => {
    expect(parseCallbackUrl("coldstorage-staging://auth/callback?code=abc&state=xyz")).toEqual({
      kind: "code",
      code: "abc",
      state: "xyz",
    });
  });

  test("parses the dev loopback shape", () => {
    expect(parseCallbackUrl("http://localhost:53682/auth/callback?code=abc&state=xyz")).toEqual({
      kind: "code",
      code: "abc",
      state: "xyz",
    });
  });

  test("surfaces an IdP error redirect (user cancelled at Google)", () => {
    expect(parseCallbackUrl("coldstorage://auth/callback?error=access_denied&state=xyz")).toEqual({
      kind: "error",
      error: "access_denied",
      description: null,
      state: "xyz",
    });
  });

  test("a redirect with neither code nor error is malformed, not ignored", () => {
    expect(parseCallbackUrl("coldstorage://auth/callback?state=xyz")).toMatchObject({ kind: "error" });
  });

  test("non-auth URLs are not ours (future deep links, random garbage)", () => {
    expect(parseCallbackUrl("coldstorage://checkout-complete")).toBeNull();
    expect(parseCallbackUrl("coldstorage-staging://checkout-complete")).toBeNull();
    expect(parseCallbackUrl("https://example.com/auth")).toBeNull();
    expect(parseCallbackUrl("not a url")).toBeNull();
  });
});

describe("schemeRedirectUri", () => {
  test("builds the per-lane callback URL that must be a registered Cognito callback", () => {
    expect(schemeRedirectUri("coldstorage")).toBe("coldstorage://auth/callback");
    expect(schemeRedirectUri("coldstorage-staging")).toBe("coldstorage-staging://auth/callback");
    expect(SCHEME_REDIRECT_URI).toBe("coldstorage://auth/callback");
  });
});

describe("decodeJwtClaims", () => {
  test("decodes the payload of a well-formed JWT (display-only, unverified)", () => {
    const payload = Buffer.from(JSON.stringify({ email: "ben@example.com", sub: "u-1" })).toString("base64url");
    expect(decodeJwtClaims(`eyJhbGciOiJub25lIn0.${payload}.sig`)).toEqual({ email: "ben@example.com", sub: "u-1" });
  });

  test("returns null for junk", () => {
    expect(decodeJwtClaims("junk")).toBeNull();
    expect(decodeJwtClaims("a.%%%.c")).toBeNull();
  });
});

describe("isFirstLinkError", () => {
  test("matches the account-linking first-sign-in failure, case-insensitively", () => {
    expect(
      isFirstLinkError({
        kind: "error",
        error: "invalid_request",
        description: "Already found an entry for username Google_108347...",
        state: "s",
      }),
    ).toBe(true);
  });

  test("ignores other errors and successful callbacks", () => {
    expect(isFirstLinkError({ kind: "error", error: "access_denied", description: null, state: "s" })).toBe(false);
    expect(isFirstLinkError({ kind: "code", code: "c", state: "s" })).toBe(false);
  });
});
