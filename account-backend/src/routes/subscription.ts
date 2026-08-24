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
 * subscription + customer ids (the webhook keeps `subscriptionActive` fresh; plan, price, card and
 * invoice detail are never duplicated into the DB, so there is nothing to drift).
 *
 * Split of responsibilities, decided 2026-07-10, widened 2026-08-24 (PADDLE.md "Managing a
 * subscription"):
 *   - invoices, receipts, card, billing address, tax id, cancel → Paddle's CUSTOMER PORTAL, one
 *     session minted on demand (`POST /portal`) and opened in the system browser. Paddle is the
 *     merchant of record; its portal is the SSOT for the money ledger, so we render none of it.
 *   - plan CHANGE (size/term) → in-app: the same picker as checkout, `previewUpdate` to show the
 *     money before committing, then `update` with `prorated_immediately` (upgrades charge the
 *     difference now; downgrades credit the balance — Paddle applies credit to future bills).
 *   - UN-cancel (`POST /resume`) → in-app, because a scheduled cancellation is the one state where
 *     sending someone to a hosted page to change their mind loses them.
 */

/** The card/PayPal on file, flattened for display. `brand`/`last4`/`expiry*` are card-only. */
interface PaymentMethodSummary {
  /** Paddle's saved-method type: "card", "paypal", "alipay", … */
  type: string;
  brand: string | null;
  last4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
}

/** What the app renders: the live subscription summarized against the sellable catalog. */
interface SubscriptionSummary {
  status: string;
  /** The catalog plan matching the subscription's price — null for an off-catalog price
   *  (e.g. a plan sold before a catalog reshape; the app then shows the raw state only). */
  plan: CatalogEntry | null;
  nextBilledAt: string | null;
  /** Set when a cancellation is already scheduled — the ISO date it takes effect. */
  cancelsAt: string | null;
  /** What the next renewal actually charges, tax included. Null when Paddle schedules no next
   *  transaction (a cancelling or paused subscription). A renewal date with no amount beside it is
   *  half an answer — this is the other half. */
  nextCharge: { amountCents: number; currency: string } | null;
  /** The payment method Paddle would charge. Null when the account has none saved. */
  paymentMethod: PaymentMethodSummary | null;
}

/** The Paddle-hosted pages the app can open, minted fresh per request (see {@link portalUrls}). */
type PortalPage = "overview" | "cancel" | "payment";

/** The caller's Paddle ids, or a clear 404 when they never subscribed. */
async function billingIdsFor(sub: string): Promise<{ subscriptionId: string; customerId: string }> {
  const [row] = await db
    .select({
      paddleSubscriptionId: accountsTable.paddleSubscriptionId,
      paddleCustomerId: accountsTable.paddleCustomerId,
    })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);
  if (!row?.paddleSubscriptionId || !row.paddleCustomerId) {
    throw new HTTPException(404, { message: "no subscription on this account" });
  }
  return { subscriptionId: row.paddleSubscriptionId, customerId: row.paddleCustomerId };
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

/**
 * The card Paddle actually charges — read from the most recent payment it CAPTURED on this
 * subscription.
 *
 * Deliberately NOT `paymentMethods.list`. That endpoint returns methods a customer explicitly saved,
 * and a subscription bought through our own API-driven checkout never creates one: the card lives on
 * the subscription as a `stored_payment_method_id` that the list has no row for. Proven on the live
 * account (2026-08-24): a captured $21.46 charge on a visa ••••8080, `stored_payment_method_id` set,
 * and an empty saved list — which the panel rendered to a paying customer as "No card saved".
 *
 * The last captured attempt cannot lie about what was charged, and `collection_mode: automatic` means
 * Paddle charges that same stored method again. It goes stale only between a card change and the next
 * renewal — and the portal button beside it is the SSOT for changing one, so that window costs nothing
 * that a wrong card wouldn't cost more.
 */
async function chargedPaymentMethod(subscriptionId: string): Promise<PaymentMethodSummary | null> {
  const page = await paddleCall("reading the payment method", () =>
    paddle.transactions
      .list({
        subscriptionId: [subscriptionId],
        // Money actually taken. A `billed`/`past_due` transaction has no captured payment to describe.
        status: ["completed", "paid"],
        // The RAW API field name: the SDK snake_cases parameter KEYS but passes VALUES through
        // untouched, so "billedAt[DESC]" would reach Paddle verbatim and 400 the whole panel.
        orderBy: "billed_at[DESC]",
        perPage: 1,
      })
      .next(),
  );
  // Last captured attempt, not the first: a retry after a decline is the one that paid.
  const captured = page[0]?.payments.filter((p) => p.status === "captured").at(-1);
  const details = captured?.methodDetails;
  if (!details) return null;
  return {
    type: details.type,
    brand: details.card?.type ?? null,
    last4: details.card?.last4 ?? null,
    expiryMonth: details.card?.expiryMonth ?? null,
    expiryYear: details.card?.expiryYear ?? null,
  };
}

/**
 * One read of everything the billing panel renders. Deliberately all-or-nothing: a partial summary
 * would let the panel draw a confident plan header above a silently missing card row, which is the
 * exact failure this surface is being rebuilt to make impossible. A throw here becomes the app's
 * "couldn't load your billing details — retry" state.
 */
async function summarize(subscriptionId: string): Promise<SubscriptionSummary> {
  const [s, catalog, paymentMethod] = await Promise.all([
    paddleCall("reading the subscription", () =>
      paddle.subscriptions.get(subscriptionId, { include: ["next_transaction"] }),
    ),
    getCatalog(),
    chargedPaymentMethod(subscriptionId),
  ]);
  const priceId = s.items[0]?.price.id;
  const totals = s.nextTransaction?.details.totals;
  return {
    status: s.status,
    plan: catalog.find((p) => p.priceId === priceId) ?? null,
    nextBilledAt: s.nextBilledAt,
    cancelsAt: s.scheduledChange?.action === "cancel" ? s.scheduledChange.effectiveAt : null,
    // Paddle states money as a minor-unit STRING ("130540"); the app's contract is whole cents.
    nextCharge: totals ? { amountCents: Number(totals.grandTotal), currency: totals.currencyCode } : null,
    paymentMethod,
  };
}

/**
 * A fresh customer-portal session. Paddle's portal URLs are single-use and short-lived, so these are
 * minted per request and NEVER cached or stored on the summary — the app asks at the moment the user
 * clicks. One session carries all three destinations we need.
 */
async function portalUrls(customerId: string, subscriptionId: string): Promise<Record<PortalPage, string | null>> {
  const session = await paddleCall("opening the billing portal", () =>
    paddle.customerPortalSessions.create(customerId, [subscriptionId]),
  );
  const forSub = session.urls.subscriptions.find((u) => u.id === subscriptionId);
  return {
    overview: session.urls.general.overview,
    cancel: forSub?.cancelSubscription ?? null,
    payment: forSub?.updateSubscriptionPaymentMethod ?? null,
  };
}

export const subscriptionRoute = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const { subscriptionId } = await billingIdsFor(c.get("sub"));
    return c.json({ subscription: await summarize(subscriptionId) });
  })
  // Mint a portal session and hand back the link the app should open in the system browser.
  .post("/portal", async (c) => {
    const { subscriptionId, customerId } = await billingIdsFor(c.get("sub"));
    const body: unknown = await c.req.json().catch(() => null);
    const requested = typeof body === "object" && body !== null ? (body as Record<string, unknown>).page : undefined;
    const page: PortalPage =
      requested === "cancel" || requested === "payment" || requested === "overview" ? requested : "overview";
    const url = (await portalUrls(customerId, subscriptionId))[page];
    if (!url) throw new HTTPException(502, { message: `Paddle returned no ${page} link for this subscription` });
    return c.json({ url });
  })
  // Preview a plan change: what Paddle would charge (or credit) RIGHT NOW. Read-only.
  .post("/change/preview", async (c) => {
    const { subscriptionId } = await billingIdsFor(c.get("sub"));
    const priceId = await validatedPriceId(await c.req.json().catch(() => null));
    const preview = await paddleCall("previewing the change", () =>
      paddle.subscriptions.previewUpdate(subscriptionId, {
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
    const { subscriptionId } = await billingIdsFor(c.get("sub"));
    const priceId = await validatedPriceId(await c.req.json().catch(() => null));
    await paddleCall("changing the plan", () =>
      paddle.subscriptions.update(subscriptionId, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: "prorated_immediately",
        // An upgrade is only real once its prorated charge clears — if the card fails, the plan
        // must NOT change. This is Paddle's default; pinned explicitly because it's load-bearing.
        onPaymentFailure: "prevent_change",
      }),
    );
    return c.json({ subscription: await summarize(subscriptionId) });
  })
  // Call off a scheduled cancellation. `scheduled_change: null` is the ONLY permitted write to that
  // field (Paddle rejects anything else), and it's the whole feature: the plan simply renews again.
  .post("/resume", async (c) => {
    const { subscriptionId } = await billingIdsFor(c.get("sub"));
    await paddleCall("calling off the cancellation", () =>
      paddle.subscriptions.update(subscriptionId, { scheduledChange: null }),
    );
    return c.json({ subscription: await summarize(subscriptionId) });
  });
