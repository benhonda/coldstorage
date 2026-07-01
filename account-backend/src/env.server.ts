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
  /** Cognito User Pool id, e.g. "ca-central-1_XXXXXXXXX" — aws-jwt-verify derives the
   *  region + JWKS URL from this, so no separate region var is needed. */
  COGNITO_USER_POOL_ID: z.string().min(1),
  /** Public app-client id (no secret — the desktop app is a public client). */
  COGNITO_USER_POOL_CLIENT_ID: z.string().min(1),
});

export const env = envSchema.parse(process.env);
