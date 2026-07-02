/** PKCE material — the crypto that makes the custom-scheme redirect safe. Headless (pure node:crypto). */
import { describe, expect, test } from "bun:test";
import { challengeS256, createPkce } from "./pkce.ts";

describe("challengeS256", () => {
  test("matches the RFC 7636 appendix-B test vector", () => {
    // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
    expect(challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("createPkce", () => {
  test("verifier is 43 base64url chars (32 bytes) and the challenge derives from it", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding
    expect(challenge).toBe(challengeS256(verifier));
  });

  test("every attempt gets fresh material", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});
