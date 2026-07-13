import { z } from "zod";

/**
 * Validated, fail-fast config — read once at cold start so a missing var breaks loudly
 * instead of surfacing as a mystery 500 on first request.
 */
const envSchema = z.object({
  /** Neon Postgres connection string. */
  DATABASE_URL: z.string().min(1),
  /** Paddle webhook signing secret (from the Paddle dashboard notification settings). */
  PADDLE_WEBHOOK_SECRET: z.string().min(1),
  /** Paddle API key — the SDK client requires one even for webhook-signature verification
   *  alone; also needed once this service calls the Paddle API directly (e.g. subscription
   *  lookups) rather than only reacting to webhooks. */
  PADDLE_API_KEY: z.string().min(1),
  PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  /** Paddle CLIENT-SIDE token (dashboard → Developer tools → Authentication) for the /checkout
   *  page's Paddle.js. Public by design (Paddle: "safe to expose in frontend code"), NOT the API
   *  key. Environment-specific like the price id; optional so the service boots without it —
   *  `GET /checkout` errors clearly if unset. */
  PADDLE_CLIENT_TOKEN: z.string().optional(),
  /** Cognito User Pool id, e.g. "ca-central-1_XXXXXXXXX" — aws-jwt-verify derives the
   *  region + JWKS URL from this, so no separate region var is needed. */
  COGNITO_USER_POOL_ID: z.string().min(1),
  /** Public app-client id (no secret — the desktop app is a public client). */
  COGNITO_USER_POOL_CLIENT_ID: z.string().min(1),

  /* ── AWS: woken up 2026-07-13 by the retrieval hard gate (root RETRIEVAL.md) ─────────────────────
   * This service made no AWS calls at all until it became the only holder of `s3:RestoreObject` —
   * the thaw the user's own credentials deliberately cannot perform. All three are TF-managed Vercel
   * env vars (infra/account-backend), never hand-set. */

  /** IAM role Vercel's OIDC token assumes in production. No long-lived keys — see aws.server.ts. */
  AWS_ROLE_ARN: z.string().min(1),
  AWS_REGION: z.string().min(1).default("ca-central-1"),
  /** The vault bucket whose blobs this service thaws (ciphertext only — it never reads a body). */
  VAULT_BUCKET_NAME: z.string().min(1),
  /** Identity Pool id — resolves a caller's ID token to the identity their S3 keys are prefixed with
   *  (`identity.server.ts`), so we can prove a blob is theirs before paying to thaw it. */
  COGNITO_IDENTITY_POOL_ID: z.string().min(1),

  /** TEST KNOB — shrinks the free tier so a test vault fills in one upload and the cap-reached gate,
   *  the over-quota upsell and the restore flow can all be exercised without pushing 25 GB. Bytes,
   *  e.g. `1000000000` for 1 GB. **Ignored outright on a production deployment** (`resolveFreeTierBytes`
   *  gates it on PADDLE_ENVIRONMENT) — it cannot shrink the real free tier under real customers.
   *  Unset it to go back to 25 GB; there is no code to revert. */
  FREE_TIER_BYTES_OVERRIDE: z.coerce.number().int().positive().optional(),
});

export const env = envSchema.parse(process.env);
