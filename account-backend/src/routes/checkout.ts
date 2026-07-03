import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { env } from "../env.server.js";

/**
 * The account's DEFAULT PAYMENT LINK target (PROD.md Phase 5c). Paddle Billing has no
 * Paddle-hosted checkout page: `transactions.create` returns `checkout.url` = the default
 * payment link set in the Paddle dashboard with `?_ptxn=<txn_id>` appended, and it's THIS
 * page's Paddle.js that detects `_ptxn` and auto-opens the overlay checkout. So the
 * dashboard's Checkout settings must point at `<this deployment>/checkout`.
 *
 * PADDLE_CLIENT_TOKEN is a client-side token (Paddle dashboard → Developer tools →
 * Authentication) — public by design ("safe to expose in frontend code"), TF-managed
 * per-stack like PADDLE_PRICE_ID since sandbox/live tokens differ.
 */
export const checkoutRoute = new Hono().get("/", (c) => {
  if (!env.PADDLE_CLIENT_TOKEN) {
    throw new HTTPException(500, { message: "checkout not configured: set PADDLE_CLIENT_TOKEN" });
  }

  // Values are our own trusted config, but inject via JSON.stringify anyway — never
  // hand-splice strings into <script>.
  const bootstrap = JSON.stringify({
    environment: env.PADDLE_ENVIRONMENT,
    token: env.PADDLE_CLIENT_TOKEN,
  });

  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ColdStorage checkout</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; color: #333; }
  </style>
</head>
<body>
  <p id="status">Loading checkout…</p>
  <script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
  <script>
    const config = ${bootstrap};
    if (config.environment === "sandbox") Paddle.Environment.set("sandbox");
    Paddle.Initialize({ token: config.token });
    // Paddle.js auto-opens the checkout for the ?_ptxn=<txn_id> query param. No param means
    // someone hit this page directly — nothing to sell without a transaction.
    if (!new URLSearchParams(location.search).has("_ptxn")) {
      document.getElementById("status").textContent =
        "No checkout to show. Start your subscription from the ColdStorage app.";
    } else {
      document.getElementById("status").textContent = "";
    }
  </script>
</body>
</html>`);
});
