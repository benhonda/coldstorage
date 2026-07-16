import { pgTable, text, integer, boolean, bigint, index, jsonb, timestamp } from "drizzle-orm/pg-core";
import { timestamps } from "./schema-utils.js";

/**
 * One row per user. Keyed on the Cognito **User Pool** `sub` (the ID token's `sub` claim) —
 * NOT the Cognito **Identity Pool** identity id that S3 keys are prefixed with
 * (`blobs/<identity-id>/...`, see infra/coldstorage/modules/stack/cognito.tf). This service
 * never touches S3, so it only ever needs the identity the ID token already carries — no
 * extra AWS call to resolve an identity id.
 *
 * The wrapped-key-blob columns are blind storage for the zero-knowledge MasterKey hierarchy
 * (see coldstorage/Sources/ColdStorageCore/ZeroKnowledgeKeys.swift `KeyBlob`): base64 text,
 * never decrypted or even decodable here — this service holds ciphertext + salts only.
 */
export const accountsTable = pgTable("accounts", {
  ...timestamps,
  sub: text().primaryKey(),

  // KeyBlob (nullable until the app's first signup PUT — see routes/key-blob.ts).
  wrappedMkPassword: text("wrapped_mk_password"),
  saltPassword: text("salt_password"),
  wrappedMkRecovery: text("wrapped_mk_recovery"),
  saltRecovery: text("salt_recovery"),
  opsLimit: integer("ops_limit"),
  memLimit: integer("mem_limit"),

  // Paddle subscription state (flipped by the webhook — see routes/webhooks/paddle.ts).
  subscriptionActive: boolean("subscription_active").notNull().default(false),
  paddleCustomerId: text("paddle_customer_id"),
  paddleSubscriptionId: text("paddle_subscription_id"),
  // Cached so GET /entitlement can look up a byte quota from the catalog without a live Paddle
  // call on this hot path (checked hourly + on every deposit) — see routes/entitlement.ts.
  paddlePriceId: text("paddle_price_id"),

  /**
   * The Cognito **Identity Pool** id for this user — the OTHER identity (see this table's note above),
   * and the one S3 keys are prefixed with (`blobs/<identityId>/…`). Resolved from the caller's verified
   * ID token via Cognito `GetId` and cached here, because retrieval must verify that the blobs it's
   * about to thaw (at our expense) actually belong to the caller. Nullable: it's populated lazily on the
   * first request that needs it, not at signup. See `identity.server.ts`.
   */
  cognitoIdentityId: text("cognito_identity_id"),

  // ── Onboarding (first-run wizard — see routes/account.ts) ──────────────────────────────────
  // The user-owned display name. Deliberately OURS, not Cognito's `name` attribute: Cognito
  // re-applies the Google attribute mapping at every federated sign-in, which would clobber an
  // in-app edit — this column is the durable SSOT, seeded from the ID token's `name` claim.
  displayName: text("display_name"),
  // Sign-in-wrap agreement ("By continuing, you agree…" on the sign-in card), recorded with the
  // account's first authenticated write. Versioned: bump TERMS_VERSION (routes/account.ts) on a
  // material terms change and stale accounts get a re-agree gate at next sign-in.
  termsVersion: text("terms_version"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true, mode: "string" }),
  // The two facts the wizard's resume rules run on (derive-don't-record: no local flags in the app).
  // onboardedAt = tour + questions seen (per-ACCOUNT — a second device never re-runs the tour);
  // recoveryCodeConfirmedAt = the user actually ticked "I've saved my recovery code" (null + an
  // unlocked vault ⇒ the app reissues a fresh code and re-shows it until confirmed).
  onboardedAt: timestamp("onboarded_at", { withTimezone: true, mode: "string" }),
  recoveryCodeConfirmedAt: timestamp("recovery_code_confirmed_at", { withTimezone: true, mode: "string" }),
  // Skippable survey answers as option IDS (see survey.ts) — analytics, not logic, hence one
  // versioned jsonb column rather than per-question columns that churn the schema as questions evolve.
  survey: jsonb(),
});

/**
 * One row per restore the user asked for (root `RETRIEVAL.md`). Two jobs in one table:
 *
 *  1. **Authorization.** The daemon will only start a restore for a job that reached `allowed` or
 *     `paid` — that's the gate. Same SOFT-gate posture as deposits/quota (the app + daemon enforce;
 *     IAM does not), and deliberately so, consistently with the rest of this service.
 *  2. **The allowance ledger.** There is no separate counter table: the rolling free allowance is
 *     `sum(allowance_bytes)` over this account's AUTHORIZED jobs inside the window. One source of
 *     truth means a counter can never drift from the jobs it's supposed to be counting (PILLAR3).
 *
 * `bytes` is split into the part the allowance covered and the part the user paid for, so the row
 * records what actually happened rather than something we'd have to re-derive from prices later.
 *
 * Money is stored as the CENTS WE QUOTED, not recomputed on read: a quote is a promise. If AWS or
 * Paddle repricing moves `retrieval-pricing.ts` tomorrow, a job quoted today still settles at the
 * number the user agreed to.
 */
export const retrievalJobsTable = pgTable(
  "retrieval_jobs",
  {
    ...timestamps,
    /** `crypto.randomUUID()` — opaque to the client; the daemon quotes it back to claim authorization. */
    id: text().primaryKey(),
    /** Cognito User Pool `sub` — same identity as `accountsTable.sub`. */
    sub: text().notNull(),

    /**
     * The S3 keys of the blobs this restore needs thawed — and therefore the exact set of objects the
     * backend will call RestoreObject on when the job is authorized. Persisted (rather than recomputed at
     * payment time) because THIS is what the money bought: the webhook fires long after the request that
     * priced it, and it must thaw precisely what was quoted, not whatever the client asks for later.
     * Ownership was proved against the caller's real identity id before this was ever written.
     */
    blobKeys: text("blob_keys").array().notNull(),

    // bigint (not integer): a 2 TB restore is ~2e12 bytes and integer caps at ~2.1e9. mode "number" is
    // safe to ~9 PB (2^53), far beyond any vault we sell.
    /** EGRESS bytes — what the user asked to get back and will actually download. */
    bytes: bigint({ mode: "number" }).notNull(),
    /** THAW bytes — the whole blob objects that must come out of Deep Archive to serve those files, from
     *  S3's own HeadObject (never the client). Can hugely exceed `bytes`: one 5 MB photo can require
     *  thawing the entire 1 GiB blob it's packed into, and we pay for all of it. Priced separately at the
     *  thaw rate — see `retrieval-pricing.ts`. */
    thawBytes: bigint("thaw_bytes", { mode: "number" }).notNull(),
    /** The EGRESS bytes covered by the free rolling allowance. THIS COLUMN IS THE LEDGER — see above.
     *  Deliberately egress, never thaw: charging a 1 GiB blob thaw against a 200 MB allowance would let
     *  one photo eat a free user's whole month (see `retrieval-pricing.ts`). */
    allowanceBytes: bigint("allowance_bytes", { mode: "number" }).notNull(),
    /** The egress the user pays for (`bytes - allowanceBytes`). Zero ⇒ the job was fully covered. */
    billableBytes: bigint("billable_bytes", { mode: "number" }).notNull(),
    /** What we quoted for `billableBytes`, in whole US cents. Zero for a fully-covered job. */
    quoteCents: integer("quote_cents").notNull(),

    /**
     * `quoted` → awaiting payment (NOT authorized; consumes no allowance).
     * `allowed` → fully inside the allowance, authorized immediately, no payment involved.
     * `paid`    → payment confirmed by the Paddle webhook; authorized.
     * `canceled`→ the user backed out of the quote, or it expired unpaid.
     * Authorized ≡ `allowed` | `paid` — the ONE predicate the daemon gate and the ledger both use.
     */
    status: text().notNull(),

    /** The Paddle transaction that actually SETTLED this job, recorded by the `transaction.completed`
     *  webhook. Null for `allowed` jobs (nothing was charged) and for any quote still unpaid. Kept for
     *  reconciliation against Paddle's own records — nothing queries by it (the webhook links via the
     *  price's `customData.retrievalJobId`), so it deliberately carries no index. */
    paddleTransactionId: text("paddle_transaction_id"),
  },
  (t) => [
    // The ledger query (this account's authorized jobs inside the rolling window) runs on every quote —
    // the hot path for this table. Without it, every quote seq-scans every restore anyone ever made.
    index("retrieval_jobs_sub_created_idx").on(t.sub, t.created_at),
  ],
);
