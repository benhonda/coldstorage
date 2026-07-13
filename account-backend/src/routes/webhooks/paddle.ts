import { Hono } from "hono";
import { EventName } from "@paddle/paddle-node-sdk";
import { db } from "../../db/index.server.js";
import { accountsTable } from "../../db/schema.js";
import { paddle } from "../../paddle.server.js";
import { env } from "../../env.server.js";
import { isActiveStatus } from "../../paddle-status.js";

/**
 * Paddle → account backend. Not authenticated with a Cognito token (Paddle is the caller,
 * not the app) — authenticity comes from the `paddle-signature` HMAC instead. The checkout
 * must pass `customData: { cognitoSub }` (Paddle.js `customData` param) so a subscription
 * can be linked back to a user; that's the only place the two identities meet.
 */
export const paddleWebhookRoute = new Hono().post("/", async (c) => {
  const signature = c.req.header("paddle-signature");
  const rawBody = await c.req.text();
  if (!signature || !rawBody) {
    return c.json({ error: "missing signature or body" }, 400);
  }

  const event = await paddle.webhooks.unmarshal(rawBody, env.PADDLE_WEBHOOK_SECRET, signature).catch(() => undefined);
  if (!event) {
    return c.json({ error: "signature verification failed" }, 400);
  }

  // A switch (not a Set.has() check) so TypeScript narrows event.data to the subscription
  // notification shape for every case in this block — the SDK's Event union types `.data`
  // differently per eventType, and that narrowing only works on literal case comparisons.
  switch (event.eventType) {
    case EventName.SubscriptionActivated:
    case EventName.SubscriptionCanceled:
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionImported:
    case EventName.SubscriptionPastDue:
    case EventName.SubscriptionPaused:
    case EventName.SubscriptionResumed:
    case EventName.SubscriptionTrialing:
    case EventName.SubscriptionUpdated: {
      const sub = event.data.customData?.["cognitoSub"];
      if (typeof sub === "string" && sub.length > 0) {
        const active = isActiveStatus(event.data.status);
        // A customer buys exactly ONE storage plan (seed script caps quantity at 1), so the
        // first item's price is the whole subscription's plan — see catalog.ts/entitlement.ts.
        const priceId = event.data.items[0]?.price?.id ?? null;
        await db
          .insert(accountsTable)
          .values({
            sub,
            subscriptionActive: active,
            paddleCustomerId: event.data.customerId,
            paddleSubscriptionId: event.data.id,
            paddlePriceId: priceId,
          })
          .onConflictDoUpdate({
            target: accountsTable.sub,
            set: {
              subscriptionActive: active,
              paddleCustomerId: event.data.customerId,
              paddleSubscriptionId: event.data.id,
              paddlePriceId: priceId,
            },
          });
      }
      // else: can't link this event to a user — nothing to persist, still ack below so
      // Paddle doesn't retry a permanently-unlinkable event forever.
      break;
    }
    default:
      break; // not a subscription lifecycle event — nothing for this service to do
  }

  // 2xx acknowledges receipt regardless of event type — Paddle retries on non-2xx.
  return c.json({ received: true });
});
