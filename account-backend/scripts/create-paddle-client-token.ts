/**
 * Mint (or reuse) the Paddle CLIENT-SIDE token that Paddle.js needs on the /checkout page.
 * This is the public token (safe to expose in frontend code / commit to TF) — NOT the secret API
 * key. Paddle added a create-client-token API in 2025, so we can mint it instead of clicking through
 * the dashboard. Requires the `client_tokens.write` permission (a full-access key has it).
 *
 * Idempotent: names the token per environment and reuses an existing active one, so re-running
 * prints the same token instead of creating duplicates.
 *
 *   export PADDLE_API_KEY='pdl_live_apikey_…'   # or a pdl_sdbx_… key
 *   task backend:paddle:client-token
 *
 * The printed `live_…` / `test_…` value goes into your TF as the (non-secret) client token:
 *   • infra/site production        → PUBLIC_PADDLE_CLIENT_TOKEN   (the live www checkout page)
 *   • infra/account-backend prod   → paddle_client_token          (the backend /checkout page)
 * then `terragrunt apply`.
 */
import { paddleFromEnv } from "./_paddle.js";

const { paddle, envName, keyMasked } = paddleFromEnv();
const tokenName = `ColdStorage checkout (${envName})`;

async function main() {
  console.log("─".repeat(72));
  console.log("ColdStorage → Paddle client-side token");
  console.log(`  key        : ${keyMasked}`);
  console.log(`  environment: ${envName}${envName === "production" ? "  ⚠️  LIVE ACCOUNT" : ""}  (from key prefix)`);
  console.log(`  token name : ${tokenName}`);
  console.log("─".repeat(72));

  // Reuse an active token with our name if one already exists (idempotent).
  let existing: Awaited<ReturnType<typeof paddle.clientTokens.get>> | undefined;
  for await (const t of paddle.clientTokens.list()) {
    if (t.status === "active" && t.name === tokenName) {
      existing = t;
      break;
    }
  }

  const token = existing ?? (await paddle.clientTokens.create({ name: tokenName, description: "Paddle.js on the /checkout page." }));
  console.log(existing ? "● reused existing active token" : "✓ created a new client-side token");
  console.log(`  id    : ${token.id}`);
  console.log(`  token : ${token.token}`);
  console.log("─".repeat(72));
  console.log("Put this value in TF (non-secret) and apply:");
  console.log("  infra/site/live/production      → PUBLIC_PADDLE_CLIENT_TOKEN");
  console.log("  infra/account-backend/live/production/terragrunt.hcl → paddle_client_token");
  console.log("─".repeat(72));
}

main().catch((e) => {
  const detail = String(e?.detail ?? e?.message ?? e);
  console.error("\n✗ Failed:", detail);
  if (/permitted|forbidden|permission/i.test(detail)) {
    console.error("  → The key lacks the client_tokens.write permission. Use a full-access key.");
  }
  process.exit(1);
});
