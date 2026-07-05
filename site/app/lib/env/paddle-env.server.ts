import { z } from "zod";

/**
 * Paddle checkout config.
 *
 * Both vars are PUBLIC_ (safe on the client — Paddle's client token is public by design)
 * and reach the browser via `window.env` (injected in `app/root.tsx`). The token is
 * OPTIONAL at boot so the marketing site still starts without Paddle configured (local dev,
 * or before Phase 4 provisions it) — the `/checkout` route shows a clear "not configured"
 * state when it's absent, rather than crashing the whole site. This mirrors how the
 * account-backend checkout page behaved (configured check at request time, not at boot).
 *
 * Provisioned per-stack by Terraform (sandbox vs live tokens differ) — see site/SPEC.md
 * Phase 4 + the account-backend's PADDLE_CLIENT_TOKEN precedent.
 */
const paddleEnv = z
  .object({
    /** Paddle client-side token (Paddle dashboard → Developer tools → Authentication); public by design. */
    PUBLIC_PADDLE_CLIENT_TOKEN: z.string().optional(),
    /** Paddle JS environment — "sandbox" or "production". */
    PUBLIC_PADDLE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  })
  .parse(process.env);

export { paddleEnv };
