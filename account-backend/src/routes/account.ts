import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.server.js";
import { accountsTable } from "../db/schema.js";
import { requireAuth } from "../middleware/require-auth.js";
import { accountPatchSchema, TERMS_VERSION } from "../account.js";
import type { AppEnv } from "../hono-env.js";

/**
 * The account profile + onboarding facts (first-run wizard — ui/DESIGN.md §onboarding).
 * GET hands the app everything its wizard resume rules derive from; PATCH (contract in
 * ../account.ts) is the single write surface.
 */
export const accountRoute = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => {
    const sub = c.get("sub");
    const [row] = await db
      .select({
        displayName: accountsTable.displayName,
        termsVersion: accountsTable.termsVersion,
        onboardedAt: accountsTable.onboardedAt,
        recoveryCodeConfirmedAt: accountsTable.recoveryCodeConfirmedAt,
      })
      .from(accountsTable)
      .where(eq(accountsTable.sub, sub))
      .limit(1);

    // No row yet is a normal brand-new account, not an error — same posture as GET /entitlement.
    return c.json({
      displayName: row?.displayName ?? null,
      termsVersion: row?.termsVersion ?? null,
      onboardedAt: row?.onboardedAt ?? null,
      recoveryCodeConfirmedAt: row?.recoveryCodeConfirmedAt ?? null,
      /** What the app compares termsVersion against to know whether to re-prompt. */
      currentTermsVersion: TERMS_VERSION,
    });
  })
  .patch("/", async (c) => {
    const sub = c.get("sub");
    const patch = accountPatchSchema.parse(await c.req.json());

    const now = sql`(now() AT TIME ZONE 'utc'::text)`;
    const set = {
      ...(patch.displayName !== undefined && { displayName: patch.displayName }),
      ...(patch.acceptTerms && { termsVersion: TERMS_VERSION, termsAcceptedAt: now }),
      ...(patch.onboarded && { onboardedAt: now }),
      ...(patch.recoveryCodeConfirmed && { recoveryCodeConfirmedAt: now }),
      ...(patch.survey !== undefined && { survey: patch.survey }),
    };

    // Upsert like key-blob's PUT: this may be the account row's very first write (the wizard's
    // name save typically races the key-blob mint, and either may create the row).
    await db
      .insert(accountsTable)
      .values({ sub, ...set })
      .onConflictDoUpdate({ target: accountsTable.sub, set });

    return c.body(null, 204);
  });
