import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.server.js";
import { accountsTable, retrievalJobsTable } from "../db/schema.js";
import { requireAuth } from "../middleware/require-auth.js";
import { chargeSavedCard, createRetrievalCheckout, blobSizes, thawBlobs } from "../retrieval.server.js";
import { identityIdFor, assertOwnedKeys } from "../identity.server.js";
import { quoteCents, billableBytes, allowanceBytesFor, ALLOWANCE_WINDOW_DAYS, TYPICAL_WAIT } from "../retrieval-pricing.js";
import type { AppEnv } from "../hono-env.js";

/**
 * Retrieval billing + the retrieval HARD GATE (root `RETRIEVAL.md`).
 *
 *   POST /retrieval/quote        → price a restore; a free one is authorized (and thawed) on the spot
 *   POST /retrieval/jobs/:id/pay → collect the money (saved card, or a checkout URL for a free user)
 *   GET  /retrieval/jobs/:id     → the app polls this; the daemon downloads once S3 says the blobs are cold-thawed
 *   POST /retrieval/jobs/:id/cancel
 *
 * THIS IS A HARD GATE, unlike the deposit/quota checks elsewhere in this service. It doesn't merely ask
 * the client nicely: the user's own Cognito credentials lack `s3:RestoreObject`, and a Deep Archive object
 * cannot be read until it's thawed. So the ONLY path from cold blob to readable bytes runs through
 * `thawBlobs()` below — and that is called only for a job that is `allowed` or `paid`. A tampered client
 * gains nothing; there is nothing to tamper with.
 *
 * Everything money-related defers to `retrieval-pricing.ts` (0% margin, charge everything, subsidize
 * nothing). Everything trust-related defers to S3 and Cognito rather than to the client: blob OWNERSHIP is
 * proved against the caller's real identity id, and blob SIZES — which set the price — come from HeadObject,
 * never from the request body.
 */

/** Statuses that mean "this job may proceed" — the one predicate the thaw, the ledger, and the app all
 *  key off. `quoted` is NOT authorized: an unpaid quote thaws nothing and burns no allowance. */
const AUTHORIZED = ["allowed", "paid"] as const;

/** Sanity ceiling on one job. Not economic — the biggest vault we sell is 10 TB, so a bigger ask is a bug
 *  or an attack, and HeadObject-ing thousands of keys to find out would itself be the attack. */
const MAX_BLOBS_PER_JOB = 4096;

interface JobView {
  jobId: string;
  status: string;
  /** Bytes the user asked to get back (what they'll download). */
  egressBytes: number;
  /** Whole-blob bytes that must be thawed to serve it — can be far larger; see retrieval-pricing.ts. */
  thawBytes: number;
  /** Egress bytes covered by the free rolling allowance. */
  allowanceBytes: number;
  /** Egress bytes the user pays for. */
  billableBytes: number;
  /** What we quoted, in whole US cents. Zero ⇒ nothing to pay; the job is already authorized. */
  quoteCents: number;
  /** True once the blobs have been (or are being) thawed and the daemon may proceed. */
  authorized: boolean;
  /** How long the thaw takes, in plain words. From the tier WE quote at (bulk) — the app must not invent
   *  its own wait; the party that picks the tier is the only one that can honestly state it. */
  typicalWait: string;
}

const view = (j: typeof retrievalJobsTable.$inferSelect): JobView => ({
  jobId: j.id,
  status: j.status,
  egressBytes: j.bytes,
  thawBytes: j.thawBytes,
  allowanceBytes: j.allowanceBytes,
  billableBytes: j.billableBytes,
  quoteCents: j.quoteCents,
  authorized: (AUTHORIZED as readonly string[]).includes(j.status),
  typicalWait: TYPICAL_WAIT,
});

/** The caller's account. A user can reach a restore before ever completing signup's key-blob PUT, so a
 *  missing row is a free account with no subscription — not a 404. */
async function accountFor(sub: string) {
  const [row] = await db
    .select({
      subscriptionActive: accountsTable.subscriptionActive,
      paddleSubscriptionId: accountsTable.paddleSubscriptionId,
    })
    .from(accountsTable)
    .where(eq(accountsTable.sub, sub))
    .limit(1);
  return row ?? { subscriptionActive: false, paddleSubscriptionId: null };
}

/**
 * Free allowance left in the current rolling window.
 *
 * The jobs table IS the ledger (see `schema.ts`): sum `allowance_bytes` over this account's AUTHORIZED
 * jobs inside the window. No counter to drift, no reset job to run — the window just slides.
 *
 * KNOWN RACE (accepted): two devices quoting at the same instant can both see the same remaining
 * allowance and each spend it. Worst case is one extra window of allowance — about two cents of egress.
 * Locking the account row on every quote would add contention to the hot path to defend two cents.
 */
async function allowanceRemaining(sub: string, subscriptionActive: boolean): Promise<number> {
  const windowStart = new Date(Date.now() - ALLOWANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${retrievalJobsTable.allowanceBytes}), 0)::bigint` })
    .from(retrievalJobsTable)
    .where(
      and(
        eq(retrievalJobsTable.sub, sub),
        inArray(retrievalJobsTable.status, [...AUTHORIZED]),
        gte(retrievalJobsTable.created_at, windowStart),
      ),
    );

  return Math.max(0, allowanceBytesFor(subscriptionActive) - Number(row?.spent ?? 0));
}

/** Parse `{ blobKeys: string[], egressBytes: number }`. `egressBytes` is what the user will download (the
 *  file ranges inside those blobs) — the ONE number we take from the client, and the one it can only hurt
 *  itself by understating: under-reporting it lowers the quote but the thaw cost, priced from real S3
 *  sizes, is charged regardless, and it cannot download more than the blobs it paid to thaw. */
function parseQuoteBody(body: unknown): { blobKeys: string[]; egressBytes: number } {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const blobKeys = b.blobKeys;
  const egressBytes = b.egressBytes;

  if (!Array.isArray(blobKeys) || blobKeys.length === 0 || !blobKeys.every((k) => typeof k === "string" && k.length > 0)) {
    throw new HTTPException(400, { message: "blobKeys must be a non-empty array of S3 keys" });
  }
  if (blobKeys.length > MAX_BLOBS_PER_JOB) {
    throw new HTTPException(400, { message: `too many blobs in one restore (max ${MAX_BLOBS_PER_JOB})` });
  }
  if (typeof egressBytes !== "number" || !Number.isInteger(egressBytes) || egressBytes <= 0) {
    throw new HTTPException(400, { message: "egressBytes must be a positive integer" });
  }
  // Dedup: the same blob named twice must not be thawed (or billed) twice.
  return { blobKeys: [...new Set(blobKeys as string[])], egressBytes };
}

export const retrievalRoute = new Hono<AppEnv>()
  .use(requireAuth)

  /**
   * Price a restore and open a job for it.
   *
   * A job fully inside the free allowance is created `allowed` and its blobs are thawed immediately — no
   * payment, no checkout, no round trip. That's the single-photo case, and it is the entire reason the
   * allowance exists: getting one picture back must never mean a payment.
   */
  .post("/quote", async (c) => {
    const sub = c.get("sub");
    const { blobKeys, egressBytes } = parseQuoteBody(await c.req.json().catch(() => null));

    // Prove the blobs are the caller's BEFORE touching S3 — thawing someone else's archive would cost us
    // real money on a stranger's data. The identity id comes from Cognito, never from the request.
    const identityId = await identityIdFor(sub, c.get("idToken"));
    try {
      assertOwnedKeys(blobKeys, identityId);
    } catch (e) {
      throw new HTTPException(403, { message: e instanceof Error ? e.message : "not your vault" });
    }

    // Authoritative sizes — the price of a thaw is set by whole-object bytes, so this can't come from the
    // client. Also proves every key really exists before we quote it.
    const sizes = await blobSizes(blobKeys);
    const thawBytes = [...sizes.values()].reduce((a, b) => a + b, 0);

    const account = await accountFor(sub);
    const remaining = await allowanceRemaining(sub, account.subscriptionActive);
    const billable = billableBytes(egressBytes, remaining);
    const covered = egressBytes - billable;
    // Nothing billable ⇒ the whole restore is free, thaw included: we eat the (fractions-of-a-cent) thaw
    // as acquisition spend rather than charge a user 62¢ to see one photo. See retrieval-pricing.ts.
    const cents = billable === 0 ? 0 : quoteCents(thawBytes, billable);
    const status = billable === 0 ? "allowed" : "quoted";

    const [job] = await db
      .insert(retrievalJobsTable)
      .values({
        id: crypto.randomUUID(),
        sub,
        blobKeys,
        bytes: egressBytes,
        thawBytes,
        allowanceBytes: covered,
        billableBytes: billable,
        quoteCents: cents,
        status,
      })
      .returning();

    // Authorized on creation ⇒ start the thaw now. (A `quoted` job thaws nothing until it's paid.)
    if (status === "allowed") await thawBlobs(blobKeys);

    return c.json(view(job!));
  })

  /**
   * Collect payment for a quoted job. Two paths, same outcome:
   *   - a subscriber's saved card is charged immediately → the app polls until the webhook says paid
   *   - a free user gets a hosted checkout URL → the app opens it in the system browser
   *
   * Nothing is thawed here, even if Paddle returns 200. A charge can still fail after we're told it was
   * accepted, and thawing on an optimistic guess is how you spend AWS money on a restore nobody paid for.
   * The webhook thaws, because the webhook is the only thing that knows the money actually landed.
   */
  .post("/jobs/:id/pay", async (c) => {
    const sub = c.get("sub");
    const [job] = await db
      .select()
      .from(retrievalJobsTable)
      .where(and(eq(retrievalJobsTable.id, c.req.param("id")), eq(retrievalJobsTable.sub, sub)))
      .limit(1);

    // Scoped to the caller's own `sub`, so another user's job id is a 404 — we don't confirm it exists.
    if (!job) throw new HTTPException(404, { message: "no such restore" });
    if (job.status === "allowed" || job.status === "paid") {
      throw new HTTPException(409, { message: "this restore is already authorized — nothing to pay" });
    }
    if (job.status !== "quoted") throw new HTTPException(409, { message: `cannot pay a ${job.status} restore` });

    const account = await accountFor(sub);
    if (account.subscriptionActive && account.paddleSubscriptionId) {
      await chargeSavedCard(account.paddleSubscriptionId, job.id, job.billableBytes, job.quoteCents);
      return c.json({ jobId: job.id, charged: true, url: null });
    }

    const { url } = await createRetrievalCheckout(sub, job.id, job.billableBytes, job.quoteCents);
    return c.json({ jobId: job.id, charged: false, url });
  })

  /** Poll a job. The app watches for `authorized`; after that the daemon polls S3 directly for the thaw to
   *  land (HeadObject, which its own credentials still allow) and downloads when it does. */
  .get("/jobs/:id", async (c) => {
    const sub = c.get("sub");
    const [job] = await db
      .select()
      .from(retrievalJobsTable)
      .where(and(eq(retrievalJobsTable.id, c.req.param("id")), eq(retrievalJobsTable.sub, sub)))
      .limit(1);

    if (!job) throw new HTTPException(404, { message: "no such restore" });
    return c.json(view(job));
  })

  /** Abandon an unpaid quote — keeps the ledger honest (a canceled job burns no allowance) and lets the
   *  app say "restore canceled" instead of leaving a quote the user already walked away from. */
  .post("/jobs/:id/cancel", async (c) => {
    const sub = c.get("sub");
    const [job] = await db
      .update(retrievalJobsTable)
      .set({ status: "canceled" })
      .where(
        and(
          eq(retrievalJobsTable.id, c.req.param("id")),
          eq(retrievalJobsTable.sub, sub),
          eq(retrievalJobsTable.status, "quoted"), // never cancel something already paid for
        ),
      )
      .returning();

    if (!job) throw new HTTPException(404, { message: "no unpaid restore with that id" });
    return c.json(view(job));
  });
