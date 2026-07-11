import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { db } from "../db/index.server.js";
import { accountsTable } from "../db/schema.js";
import { paddle } from "../paddle.server.js";
import { getCatalog } from "../catalog.server.js";
import { requireAuth } from "../middleware/require-auth.js";
import type { AppEnv } from "../hono-env.js";
import type { CatalogEntry } from "../catalog.js";

/**
 * Manage the caller's subscription (the "manage plan" surface behind the app's account card).
 * Everything here reads/acts on the LIVE Paddle subscription — the DB row only supplies the
 * subscription id (the webhook keeps `subscriptionActive` fresh; plan detail is never duplicated
 * into the DB, so there is nothing to drift).
 *
 * Split of responsibilities, decided 2026-07-10 (PADDLE.md "Managing a subscription"):
 *   - cancel + payment method → Paddle-HOSTED pages (`managementUrls` off the subscription
 *     entity), opened in the system browser. Paddle is the merchant of record — its pages own
 *     the confirm/effective-date/refund UX, and we carry zero of that surface.
 *   - plan CHANGE (size/term) → in-app: the same picker as checkout, `previewUpdate` to show the
 *     money before committing, then `update` with `prorated_immediately` (upgrades charge the
 *     difference now; downgrades credit the balance — Paddle applies credit to future bills).
 */

/** What the app renders: the live subscription summarized against the sellable catalog. */
interface SubscriptionSummary {
  status: string;
  /** The catalog plan matching the subscription's price — null for an off-catalog price
   *  (e.g. a plan sold before a catalog reshape; the app then shows the raw state only). */
  plan: CatalogEntry | null;
  nextBilledAt: string | null;
  /** Set when a cancellation is already scheduled — the ISO date it takes effect. */
  cancelsAt: string | null;
  /** Paddle-hosted management pages — open in the system browser. */
  cancelUrl: string | null;
  updatePaymentMethodUrl: string | null;
}

/** The caller's subscription id, or a clear 404 when they never subscribed. */
async function subscriptionIdFor(sub: string): Promise<string> {
  const [row] = await db
    .select({ paddleSubscriptionId: accountsTable.paddleSubscriptionId })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);
  if (!row?.paddleSubscriptionId) {
    throw new HTTPException(404, { message: "no subscription on this account" });
  }
  return row.paddleSubscriptionId;
}

/** Parse + catalog-validate the `{ priceId }` body every change/preview takes. */
async function validatedPriceId(body: unknown): Promise<string> {
  const priceId = typeof body === "object" && body !== null ? (body as Record<string, unknown>).priceId : undefined;
  if (typeof priceId !== "string" || priceId.length === 0) {
    throw new HTTPException(400, { message: "priceId is required — pick a plan from GET /catalog" });
  }
  const catalog = await getCatalog().catch((e) => {
    throw new HTTPException(502, { message: `plan catalog unavailable: ${e instanceof Error ? e.message : String(e)}` });
  });
  if (!catalog.some((p) => p.priceId === priceId)) {
    throw new HTTPException(400, { message: "unknown priceId — not a plan in the current catalog" });
  }
  return priceId;
}

/** Run a Paddle call, surfacing its error detail as a clear 502 instead of an opaque 500 —
 *  a key-permission gap (see PADDLE.md "Runtime key scope") should say so to the app. */
async function paddleCall<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((e: unknown) => {
    const detail = (e as { detail?: string }).detail ?? (e instanceof Error ? e.message : String(e));
    throw new HTTPException(502, { message: `${op} failed: ${detail}` });
  });
}

async function summarize(subscriptionId: string): Promise<SubscriptionSummary> {
  const [s, catalog] = await Promise.all([
    paddleCall("reading the subscription", () => paddle.subscriptions.get(subscriptionId)),
    getCatalog(),
  ]);
  const priceId = s.items[0]?.price.id;
  return {
    status: s.status,
    plan: catalog.find((p) => p.priceId === priceId) ?? null,
    nextBilledAt: s.nextBilledAt,
    cancelsAt: s.scheduledChange?.action === "cancel" ? s.scheduledChange.effectiveAt : null,
    cancelUrl: s.managementUrls?.cancel ?? null,
    updatePaymentMethodUrl: s.managementUrls?.updatePaymentMethod ?? null,
  };
}

export const subscriptionRoute = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const id = await subscriptionIdFor(c.get("sub"));
    return c.json({ subscription: await summarize(id) });
  })
  // Preview a plan change: what Paddle would charge (or credit) RIGHT NOW. Read-only.
  .post("/change/preview", async (c) => {
    const id = await subscriptionIdFor(c.get("sub"));
    const priceId = await validatedPriceId(await c.req.json().catch(() => null));
    const preview = await paddleCall("previewing the change", () =>
      paddle.subscriptions.previewUpdate(id, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: "prorated_immediately",
      }),
    );
    const result = preview.updateSummary?.result;
    return c.json({
      // "charge" = pay the difference now; "credit" = balance applied to future bills.
      action: result?.action ?? "charge",
      amountCents: result ? Number(result.amount) : 0,
      currency: result?.currencyCode ?? "USD",
      nextBilledAt: preview.nextBilledAt,
    });
  })
  // Apply the plan change. The `subscription.updated` webhook keeps the DB's activity flag fresh.
  .post("/change", async (c) => {
    const id = await subscriptionIdFor(c.get("sub"));
    const priceId = await validatedPriceId(await c.req.json().catch(() => null));
    await paddleCall("changing the plan", () =>
      paddle.subscriptions.update(id, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: "prorated_immediately",
        // An upgrade is only real once its prorated charge clears — if the card fails, the plan
        // must NOT change. This is Paddle's default; pinned explicitly because it's load-bearing.
        onPaymentFailure: "prevent_change",
      }),
    );
    return c.json({ subscription: await summarize(id) });
  });
