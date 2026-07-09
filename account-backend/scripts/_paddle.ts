/**
 * Shared helper for the one-off Paddle ops scripts (seed-paddle-catalog, create-paddle-client-token).
 * Builds a Paddle client from PADDLE_API_KEY and auto-detects sandbox vs production from the key
 * prefix — a sandbox key (pdl_sdbx_…) only works against sandbox, a live key (pdl_live_…) only
 * against production, so the key already tells us which. Exits with a clear message on a bad key.
 */
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

export function paddleFromEnv(): { paddle: Paddle; envName: "sandbox" | "production"; keyMasked: string } {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error("✗ PADDLE_API_KEY is required. Export it in your shell (never commit it).");
    process.exit(1);
  }
  const envName = apiKey.startsWith("pdl_live_") ? "production" : apiKey.startsWith("pdl_sdbx_") ? "sandbox" : null;
  if (!envName) {
    console.error("✗ PADDLE_API_KEY doesn't look like a Paddle API key (expected a pdl_live_… or pdl_sdbx_… prefix).");
    process.exit(1);
  }
  const paddle = new Paddle(apiKey, {
    environment: envName === "production" ? Environment.production : Environment.sandbox,
  });
  return { paddle, envName, keyMasked: `${apiKey.slice(0, 16)}…(masked)` };
}
