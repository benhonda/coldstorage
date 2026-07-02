/**
 * PKCE + state material for the OAuth authorization-code flow (RFC 7636). Pure `node:crypto` — no
 * Electron — so it unit-tests headless (pkce.test.ts). S256 is the only challenge method Cognito
 * supports, and PKCE is what makes a custom-scheme redirect safe: another app hijacking the
 * `coldstorage://` scheme can steal the code but can't redeem it without the verifier.
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkceMaterial {
  /** code_verifier — 32 random bytes → 43 base64url chars (RFC 7636 wants 43–128). */
  verifier: string;
  /** code_challenge = BASE64URL(SHA256(ASCII(verifier))) — the S256 method. */
  challenge: string;
  /** CSRF nonce, echoed back on the redirect — also the key that matches a callback to its pending
   * sign-in attempt, so duplicate/foreign callbacks are dropped instead of double-exchanged. */
  state: string;
}

/** S256 challenge for a verifier. Split out for the RFC 7636 appendix-B test vector. */
export const challengeS256 = (verifier: string): string =>
  createHash("sha256").update(verifier, "ascii").digest().toString("base64url");

/** Fresh, cryptographically-random material for one sign-in attempt. Never reused. */
export const createPkce = (): PkceMaterial => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeS256(verifier), state: randomBytes(16).toString("base64url") };
};
