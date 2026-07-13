import { Hono } from "hono";
import { EventName } from "@paddle/paddle-node-sdk";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.server.js";
import { accountsTable, retrievalJobsTable } from "../../db/schema.js";
import { paddle } from "../../paddle.server.js";
import { thawBlobs } from "../../retrieval.server.js";
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

    /**
     * The money for a RESTORE has actually settled (root `RETRIEVAL.md`). This is the ONLY thing that
     * authorizes a paid restore — not the 200 we got when we started the charge, which means only that
     * Paddle accepted the request, not that the card paid.
     *
     * Both payment paths converge here and are linked the same way: the inline price we billed carries
     * `customData.retrievalJobId` (see `retrieval.server.ts`). We match on THAT rather than a transaction
     * id because the saved-card path never gives us one — Paddle's `createOneTimeCharge` resolves with
     * the subscription, not the transaction it spawns. The settled transaction id is recorded here, from
     * the event itself, which is also the only id that's actually true (a checkout the user abandoned
     * would have left us holding a transaction that never paid).
     *
     * Idempotent by construction: scoped to `status: "quoted"`, so Paddle's webhook retries can't re-flip
     * a job that has since been paid or canceled. A `transaction.completed` for a subscription renewal
     * carries no `retrievalJobId` and falls straight through.
     */
    case EventName.TransactionCompleted: {
      const jobId = event.data.items
        .map((item) => item.price?.customData?.["retrievalJobId"])
        .find((v): v is string => typeof v === "string" && v.length > 0);
      if (!jobId) break; // not a retrieval charge — a subscription renewal or one-off we don't track

      const [job] = await db
        .select({ id: retrievalJobsTable.id, status: retrievalJobsTable.status, blobKeys: retrievalJobsTable.blobKeys })
        .from(retrievalJobsTable)
        .where(eq(retrievalJobsTable.id, jobId))
        .limit(1);
      if (!job) break; // unknown job — nothing we can act on; ack so Paddle stops retrying forever
      if (job.status === "paid") break; // already fully handled: thawed AND marked. The idempotency stop.

      // ORDER IS LOAD-BEARING: thaw FIRST, mark paid SECOND. Flipping the status first would be a trap —
      // if the thaw then failed, we'd return non-2xx, Paddle would retry, and the retry would find a job
      // that is already `paid` and quietly do nothing. The user would have paid for a restore whose data
      // never thaws. Thawing first means a failure leaves the job in a state the retry can still see and
      // finish. `thawBlobs` is idempotent, so re-running it after a partial failure is free.
      //
      // THE GATE OPENS HERE, and nowhere else: the user's own Cognito role has no `s3:RestoreObject`, and
      // Deep Archive can't be read until it's thawed. Until this line runs, the blobs they just paid for
      // are unreadable to everyone, including them.
      //
      // We thaw exactly `job.blobKeys` — the set that was priced and ownership-checked at quote time —
      // never anything a client could name now.
      await thawBlobs(job.blobKeys);

      await db
        .update(retrievalJobsTable)
        .set({ status: "paid", paddleTransactionId: event.data.id })
        .where(eq(retrievalJobsTable.id, job.id));

      // A job that was `canceled` but whose payment landed anyway (the user cancelled mid-checkout) is
      // deliberately honoured here rather than refused: we took the money, so they get the data.
      console.log(`retrieval: job ${job.id} paid (paddle txn ${event.data.id}) — thawing ${job.blobKeys.length} blob(s)`);
      break;
    }

    default:
      break; // not an event this service acts on
  }

  // 2xx acknowledges receipt regardless of event type — Paddle retries on non-2xx.
  return c.json({ received: true });
});
