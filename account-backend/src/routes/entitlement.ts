import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.server.js";
import { accountsTable } from "../db/schema.js";
import { requireAuth } from "../middleware/require-auth.js";
import type { AppEnv } from "../hono-env.js";

/**
 * Soft gate today (PROD.md Phase 4 note): the app checks this before allowing a
 * deposit. It does NOT block AWS access at the IAM layer — Cognito Identity Pool hands out
 * S3 creds independently of this service. A hard gate (Pre-Token-Generation Lambda +
 * IAM policy condition) is a deliberate later step, not an oversight.
 */
export const entitlementRoute = new Hono<AppEnv>().use(requireAuth).get("/", async (c) => {
  const sub = c.get("sub");
  const [row] = await db
    .select({ subscriptionActive: accountsTable.subscriptionActive })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);

  return c.json({ active: row?.subscriptionActive ?? false });
});
