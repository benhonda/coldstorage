/**
 * The live Paddle side of retrieval billing (root `RETRIEVAL.md`). The pure money math is in
 * `retrieval-pricing.ts`; this module only knows how to *collect* it. Mirrors the
 * `catalog.ts` / `catalog.server.ts` split exactly.
 *
 * Every restore is billed as a **non-catalog (inline) price** for its own exact amount — a restore's
 * price is a function of its bytes, so there is no finite set of prices to put in the catalog. Both
 * payment paths below use the same inline price; they differ only in HOW the money is collected:
 *
 *   - **Subscriber** (has a Paddle subscription + a card on file): charge that saved card immediately
 *     via `subscriptions.createCharge`. No checkout, no browser — the app shows a quote, the user
 *     confirms in-app, done. This is the path that makes a restore feel like part of the product.
 *   - **Free-tier user** (no subscription, no card): there is nothing to charge, so they get a hosted
 *     Paddle checkout — same pattern `checkout-session.ts` already uses for a new subscription.
 *
 * Both return a Paddle TRANSACTION id, which we store on the job. That id — not `customData` — is what
 * the `transaction.completed` webhook matches on, so the two paths converge on one linking mechanism.
 */
import { HTTPException } from "hono/http-exception";
import { HeadObjectCommand, RestoreObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { paddle } from "./paddle.server.js";
import { s3 } from "./aws.server.js";
import { env } from "./env.server.js";
import { RETRIEVAL_PRODUCT_NAME } from "./plan-sizes.js";

const PRODUCT_TTL_MS = 5 * 60 * 1000;

let productCache: { at: number; id: string } | null = null;

/**
 * The id of the Paddle product retrieval charges hang off, resolved BY NAME (the `plan-sizes.ts` SSOT)
 * and cached — same reason `getCatalog()` caches: Fluid Compute reuses instances, so most requests never
 * hit Paddle. Resolving by name rather than an env var/TF variable keeps the seed script the single
 * place the catalog is defined; the trade is this lookup, which is why it's cached.
 *
 * Throws loudly if the product is missing — that means the account was never seeded (or the product was
 * archived), and billing a restore against a product that doesn't exist would fail deeper in, with a
 * much worse error.
 */
export async function getRetrievalProductId(): Promise<string> {
  if (productCache && Date.now() - productCache.at < PRODUCT_TTL_MS) return productCache.id;

  for await (const p of paddle.products.list()) {
    if (p.status === "active" && p.name === RETRIEVAL_PRODUCT_NAME) {
      productCache = { at: Date.now(), id: p.id };
      return p.id;
    }
  }
  throw new Error(
    `Paddle has no active product named "${RETRIEVAL_PRODUCT_NAME}" — run \`task backend:paddle:seed -- --env <env> --apply\` to create it.`,
  );
}

/** Human-readable line item. The user sees this on the Paddle receipt, so it says what they bought in
 *  plain words — not "retrieval_job_a1b2" (CANON §5: plain, factual, no jargon). */
function describe(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  const size = gb < 1 ? `${Math.max(1, Math.round(gb * 1024))} MB` : `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `Restoring ${size} from cold storage`;
}

/**
 * The inline price both payment paths bill. `quantity: 1` — a restore is one indivisible thing.
 *
 * `customData.retrievalJobId` IS THE LINK back to our job, and it has to be: the subscription-charge
 * call below returns a `Subscription`, not the transaction it creates, so there is no transaction id to
 * capture at call time. The `transaction.completed` webhook reads this off `items[].price.customData`
 * instead — one mechanism that works identically for the saved-card and hosted-checkout paths.
 *
 * NOTE the deliberate absence of `billingCycle`: omitting it makes this a ONE-TIME price. (The
 * subscription variant of Paddle's non-catalog price type doesn't even accept the field — a charge is
 * inherently one-off — and omitting it is what lets one object satisfy both call sites' types.) A
 * recurring price here would sign the user up to pay for the same restore every year, forever.
 */
async function inlineItem(jobId: string, bytes: number, cents: number) {
  return {
    quantity: 1,
    price: {
      productId: await getRetrievalProductId(),
      name: "Data retrieval",
      description: describe(bytes),
      unitPrice: { amount: String(cents), currencyCode: "USD" as const },
      quantity: { minimum: 1, maximum: 1 },
      taxMode: "account_setting" as const,
      customData: { retrievalJobId: jobId },
    },
  };
}

/** Surface Paddle's own error detail as a 502 rather than an opaque 500 — same helper shape as
 *  `routes/subscription.ts` (a key-permission gap should say so, not look like a crash). */
async function paddleCall<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((e: unknown) => {
    const detail = (e as { detail?: string }).detail ?? (e instanceof Error ? e.message : String(e));
    throw new HTTPException(502, { message: `${op} failed: ${detail}` });
  });
}

/**
 * Bill a subscriber's saved card immediately.
 *
 * `effectiveFrom: "immediately"` is load-bearing: the alternative (`next_billing_period`) would let the
 * user restore now and pay for it up to a year later, and no `transaction.completed` would arrive to
 * authorize the job. The money settles before any data moves.
 *
 * Returns nothing on purpose. Paddle's `createOneTimeCharge` resolves with the SUBSCRIPTION, not the
 * transaction it just created, so there is no id worth capturing here — and a 200 from this call means
 * only "Paddle accepted the charge", never "the card actually paid". Authorization comes from the
 * webhook, and nowhere else.
 */
export async function chargeSavedCard(subscriptionId: string, jobId: string, bytes: number, cents: number): Promise<void> {
  const item = await inlineItem(jobId, bytes, cents);
  await paddleCall("charging your saved payment method", () =>
    paddle.subscriptions.createOneTimeCharge(subscriptionId, { effectiveFrom: "immediately", items: [item] }),
  );
}

/**
 * Start a hosted checkout for a user with no card on file. Returns the URL for the app to open in the
 * system browser; completion is learned from the webhook, exactly as `checkout-session.ts` does it.
 */
export async function createRetrievalCheckout(sub: string, jobId: string, bytes: number, cents: number): Promise<{ url: string }> {
  const item = await inlineItem(jobId, bytes, cents);
  const txn = await paddleCall("starting checkout for this restore", () =>
    paddle.transactions.create({ items: [item], customData: { cognitoSub: sub, retrievalJobId: jobId } }),
  );

  const url = txn.checkout?.url;
  if (!url) {
    // Same failure mode `checkout-session.ts` documents: no default payment link set on the account.
    throw new HTTPException(500, {
      message: "Paddle returned no checkout URL — set a default payment link in the Paddle dashboard",
    });
  }
  return { url };
}

/* ══ S3: the hard gate ═══════════════════════════════════════════════════════════════════════════════
 * The user's own Cognito role has PutObject + GetObject on their prefix, but NOT `s3:RestoreObject`
 * (infra/coldstorage/modules/stack/cognito.tf). Deep Archive objects cannot be downloaded until they're
 * thawed, and GetObject against a cold object fails with InvalidObjectState — so withholding the thaw
 * withholds the data. THIS is what makes a retrieval charge enforceable rather than advisory, and why
 * these two functions are the most security-relevant code in this service.
 *
 * Everything here touches ciphertext metadata only. No object body is ever read. */

/**
 * The TRUE size of each blob object, straight from S3.
 *
 * Never take these bytes from the client. They set the price (a thaw is billed on whole-object bytes),
 * so a client that could name its own sizes could name a 2 TB restore as 1 byte and pay 53¢ for it.
 * HeadObject is the authoritative answer and costs a fraction of a cent.
 *
 * A missing key is a hard error rather than a skipped zero: it means the client asked us to thaw
 * something that isn't there, and quoting that as "free" would be quoting a lie.
 */
export async function blobSizes(keys: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const results = await Promise.all(
    keys.map(async (key) => {
      const out = await s3.send(new HeadObjectCommand({ Bucket: env.VAULT_BUCKET_NAME, Key: key })).catch((e: unknown) => {
        const code = e instanceof S3ServiceException ? e.name : String(e);
        throw new HTTPException(404, { message: `blob "${key}" isn't in the vault (${code})` });
      });
      return [key, out.ContentLength ?? 0] as const;
    }),
  );
  for (const [key, size] of results) sizes.set(key, size);
  return sizes;
}

/** How long a thawed copy stays downloadable. Long enough for a 48 h bulk thaw to finish and the user to
 *  actually collect it on their own schedule; short enough that the temporary copy (which we also pay to
 *  store) doesn't linger. Re-thawing later is a new job, and correctly a new charge. */
const THAW_DAYS = 5;

/**
 * Thaw the blobs for an AUTHORIZED job — the single act that turns a paid quote into retrievable data.
 * Call this ONLY for a job that is `allowed` or `paid`; it is the moment we start spending AWS money.
 *
 * BULK tier (~48 h): the cheapest, and the only tier V1 sells. The quote was priced at bulk rates, so
 * requesting a faster tier here would silently spend money we did not charge for.
 *
 * Idempotent, and it has to be: Paddle can redeliver a webhook, and a re-thaw of an in-flight object
 * would otherwise blow up the retry. `RestoreAlreadyInProgress` means another attempt already did the
 * work — exactly the daemon's own `requestThaw` reasoning (`S3Store.swift`).
 */
export async function thawBlobs(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        await s3.send(
          new RestoreObjectCommand({
            Bucket: env.VAULT_BUCKET_NAME,
            Key: key,
            RestoreRequest: { Days: THAW_DAYS, GlacierJobParameters: { Tier: "Bulk" } },
          }),
        );
      } catch (e: unknown) {
        if (e instanceof S3ServiceException && e.name === "RestoreAlreadyInProgress") return;
        // An object already thawed and still within its window also 409s on some paths; treat any
        // "already" case as done, and surface anything else — a silent thaw failure would leave the
        // user paid-up and staring at data that never arrives.
        const detail = e instanceof Error ? e.message : String(e);
        throw new HTTPException(502, { message: `couldn't start the restore for "${key}": ${detail}` });
      }
    }),
  );
}
