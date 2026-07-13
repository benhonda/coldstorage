import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.server.js";
import { accountsTable } from "../db/schema.js";
import { requireAuth } from "../middleware/require-auth.js";
import { getCatalog } from "../catalog.server.js";
import { FREE_TIER_BYTES } from "../plan-sizes.js";
import type { AppEnv } from "../hono-env.js";

/**
 * Soft gate today (PROD.md Phase 4 note): the app checks this before allowing a
 * deposit. It does NOT block AWS access at the IAM layer — Cognito Identity Pool hands out
 * S3 creds independently of this service. A hard gate (Pre-Token-Generation Lambda +
 * IAM policy condition) is a deliberate later step, not an oversight. (Retrieval is the
 * exception: it IS hard-gated, at IAM — see root `RETRIEVAL.md`.)
 *
 * **`quotaBytes` is the deposit gate. `active` is not** (PROD.md "Free-tier entitlement flip"):
 * every signed-in account gets a byte quota — {@link FREE_TIER_BYTES} (25 GB, forever) with no
 * subscription, the plan's allowance with one — and deposits are gated on that ONE number. `active`
 * survives only as a UI signal, telling the app which upsell to show (subscribe vs. change plan);
 * it no longer decides whether a user may back up at all.
 *
 * The paid quota is looked up from the cached catalog by the `paddlePriceId` the webhook persisted —
 * never a live Paddle call on this hot path (checked hourly + on every deposit). `null` means "don't
 * enforce a byte cap" and can now only happen to a SUBSCRIBER whose price isn't in the catalog (never
 * cached, or since retired): that fails OPEN, because a paying customer must never be blocked by our
 * own lookup miss. A free account always gets a real number.
 */
export const entitlementRoute = new Hono<AppEnv>().use(requireAuth).get("/", async (c) => {
  const sub = c.get("sub");
  const [row] = await db
    .select({ subscriptionActive: accountsTable.subscriptionActive, paddlePriceId: accountsTable.paddlePriceId })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);

  const active = row?.subscriptionActive ?? false;
  if (!active) return c.json({ active, quotaBytes: FREE_TIER_BYTES });

  let quotaBytes: number | null = null;
  if (row?.paddlePriceId) {
    const catalog = await getCatalog();
    const plan = catalog.find((p) => p.priceId === row.paddlePriceId);
    if (plan) {
      quotaBytes = plan.quotaBytes;
    } else {
      console.warn(`entitlement: priceId "${row.paddlePriceId}" for sub "${sub}" not found in current catalog — returning quotaBytes: null`);
    }
  }

  return c.json({ active, quotaBytes });
});
