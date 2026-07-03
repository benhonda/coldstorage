import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { paddle } from "../paddle.server.js";
import { env } from "../env.server.js";
import { requireAuth } from "../middleware/require-auth.js";
import type { AppEnv } from "../hono-env.js";

/**
 * Start a subscription checkout (PROD.md Phase 5c). Creates the Paddle transaction SERVER-SIDE so we can
 * attach `customData.cognitoSub` — the only reliable way to carry it (Paddle copies a transaction's
 * custom data onto the subscription it creates, so the `subscription.*` webhooks link back to this user).
 * Returns the hosted-checkout URL for the app to open in the system browser; completion is learned from
 * the webhook flipping `subscriptionActive` (the app polls `GET /entitlement`), not from this response.
 */
export const checkoutSessionRoute = new Hono<AppEnv>().use(requireAuth).post("/", async (c) => {
  const sub = c.get("sub");
  if (!env.PADDLE_PRICE_ID) {
    throw new HTTPException(500, { message: "checkout not configured: set PADDLE_PRICE_ID" });
  }

  const txn = await paddle.transactions.create({
    items: [{ priceId: env.PADDLE_PRICE_ID, quantity: 1 }],
    customData: { cognitoSub: sub },
  });

  // `checkout.url` is populated from the account's default payment link — null if none is set in the
  // Paddle dashboard, in which case there's no page to send the user to.
  const url = txn.checkout?.url;
  if (!url) {
    throw new HTTPException(500, { message: "Paddle returned no checkout URL — set a default payment link in the Paddle dashboard" });
  }

  return c.json({ url });
});
