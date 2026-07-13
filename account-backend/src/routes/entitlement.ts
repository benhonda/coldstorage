import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.server.js";
import { accountsTable } from "../db/schema.js";
import { requireAuth } from "../middleware/require-auth.js";
import { getCatalog } from "../catalog.server.js";
import type { AppEnv } from "../hono-env.js";

/**
 * Soft gate today (PROD.md Phase 4 note): the app checks this before allowing a
 * deposit. It does NOT block AWS access at the IAM layer — Cognito Identity Pool hands out
 * S3 creds independently of this service. A hard gate (Pre-Token-Generation Lambda +
 * IAM policy condition) is a deliberate later step, not an oversight.
 *
 * `quotaBytes` (PROD.md "Storage quota enforcement") is the plan's byte allowance, looked up
 * from the cached catalog by the `paddlePriceId` the webhook persisted — never a live Paddle
 * call on this hot path (checked hourly + on every deposit). `null` means "don't enforce a byte
 * cap": no active subscription, no price cached yet, or a price that's since dropped out of the
 * catalog (e.g. retired) — fails OPEN on this specific lookup, since `active` is still the
 * primary gate and a byte cap is an added restriction, not the security boundary.
 */
export const entitlementRoute = new Hono<AppEnv>().use(requireAuth).get("/", async (c) => {
  const sub = c.get("sub");
  const [row] = await db
    .select({ subscriptionActive: accountsTable.subscriptionActive, paddlePriceId: accountsTable.paddlePriceId })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);

  const active = row?.subscriptionActive ?? false;
  let quotaBytes: number | null = null;
  if (active && row?.paddlePriceId) {
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
