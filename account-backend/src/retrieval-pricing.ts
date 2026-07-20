/**
 * Retrieval pricing SSOT (PROD.md free-tier plan phase A; spec in root `RETRIEVAL.md`, money model in
 * private `strategy/CANON.md` §7). Pure + dependency-free so it unit-tests without the SDK —
 * the live Paddle calls live in `retrieval.server.ts`, exactly like `catalog.ts` / `catalog.server.ts`.
 *
 * THE RULE (settled 2026-07-12, Ben): **retrieval runs at 0% margin — charge the user everything,
 * subsidize nothing.** Margin is made on storage only. We absorb costs only where margin exists to
 * absorb them (subscriptions); retrieval has none, so a quote recovers its true cost exactly:
 * AWS's restore + egress, PLUS both halves of Paddle's fee (5% + $0.50).
 *
 * Two consequences worth stating, because both are easy to "helpfully" break later:
 *   1. Do NOT round the per-GB rate up to a clean number. 9.74¢/GB rounded to 10¢ books ~$5 of margin
 *      on a 2 TB restore — a pricing subsidy in reverse, and a violation of the rule.
 *   2. Do NOT drop the $0.50 recovery to make small restores prettier. That would make storage margin
 *      quietly fund retrieval, which is the exact thing the rule exists to prevent.
 * The ONE deliberate exception is the free allowance below — booked as acquisition spend, not pricing.
 */

/** A "GB" as AWS actually BILLS it: 2^30 bytes (a gibibyte), not 10^9 — verified against AWS S3 pricing
 *  docs 2026-07-12. This matters: costing 100 GiB as 107.4 decimal-GB would overcharge ~7.4%, which is
 *  margin, which breaks the rule. Customer-facing plan SIZES stay decimal (`plan-sizes.ts`, "1 TB" =
 *  10^12) — that's marketing convention for a quota, and deliberately a different number from this one. */
const BYTES_PER_BILLED_GB = 1024 ** 3;

/* ── Cost inputs (AWS list prices, us-east-1-class, verified 2026-07-12) ─────────────────────────── */
/** S3 Glacier Deep Archive BULK retrieval ("thaw"): $0.0025/GB. Bulk is the only tier V1 sells. */
const GDA_BULK_THAW_USD_PER_GB = 0.0025;

/**
 * How long a restore takes, in plain words — shown to the user before they commit.
 *
 * It lives HERE, next to the rate it's priced at, because the two are the same decision: we quote the
 * BULK tier, so we must wait the bulk tier's ~48 hours. Quoting bulk and promising a faster tier's wait
 * would be a lie; quoting bulk and then *requesting* a faster tier would spend money we never charged for
 * (see `thawBlobs`). The backend picks the tier, so the backend states the wait — the daemon and the app
 * must not invent their own (the app briefly hardcoded "~48 hours", which is how these drift).
 */
export const TYPICAL_WAIT = "~48 hours";
/** Data transfer OUT to internet, first-10-TB/month tier: $0.09/GB. 36× the thaw rate. */
const EGRESS_USD_PER_GB = 0.09;

/* ── Paddle's cut (merchant of record) ───────────────────────────────────────────────────────────── */
/** Paddle keeps 5% of whatever we charge — so the quote must be grossed UP by 1/(1-0.05) to net our cost. */
const PADDLE_RATE = 0.05;
/** …plus a flat $0.50 per transaction, recovered in full (see rule note 2 above). */
const PADDLE_FIXED_USD = 0.5;

/* ── The free rolling allowance — the one accepted subsidy ───────────────────────────────────────── */
/** Rolling window the allowance refreshes over. A 30-day WINDOW (not an annual pool) is deliberate:
 *  same worst case, ~12× lower expected cost, because it bounds what any single restore event can take
 *  for free and lets unused months expire. See `strategy/CANON.md` §7 "Why a monthly window". */
export const ALLOWANCE_WINDOW_DAYS = 30;
/** Paid plans: 1 GB per window. Funded by storage margin — consistent with the rule. */
export const ALLOWANCE_BYTES_SUBSCRIBED = 1_000_000_000;
/** Free tier: 200 MB per window. NOT funded by margin — knowingly booked as acquisition spend, the same
 *  line item the 25 GB free tier itself sits on (Ben, 2026-07-12). Its whole job is that getting one
 *  photo back never costs a free user 62¢ and a checkout. */
export const ALLOWANCE_BYTES_FREE = 200_000_000;

/** The allowance for an account, by whether it has an active paid subscription. */
export function allowanceBytesFor(subscriptionActive: boolean): number {
  return subscriptionActive ? ALLOWANCE_BYTES_SUBSCRIBED : ALLOWANCE_BYTES_FREE;
}

/**
 * What a restore must cost, in whole US cents, to recover its true cost at 0% margin.
 *
 * TWO cost drivers, not one, because a restore spends AWS money in two different shapes:
 *
 *   - `thawBytes` — the **whole blob objects** that have to be thawed out of Deep Archive. S3's
 *     RestoreObject works on whole objects, and blobs are packed up to 1 GiB (`BlobPlanner.blobCap`),
 *     so getting one 5 MB photo back means thawing the entire 1 GiB blob it happens to sit in. We pay
 *     for all of it.
 *   - `egressBytes` — what the user actually downloads (the ranged GETs of their files).
 *
 * Blending these into one per-GB rate on the downloaded bytes (an earlier draft did) UNDERCHARGES any
 * restore that pulls a little from a lot of blobs — ~24% on a realistic 10 GB-across-100-blobs job. On a
 * full-vault restore the two converge (you want ~all of every blob), which is exactly why the error is
 * easy to miss. Under the 0%-margin rule, undercharging is a subsidy funded by storage margin. So: bill
 * each driver at its own real rate.
 *
 *     price = (thawGB × $0.0025 + egressGB × $0.09 + $0.50) / 0.95
 *              └──────────── AWS ────────────┘   └ Paddle ┘  └ 5% gross-up ┘
 *
 * Rounded UP to the cent — sub-cent amounts aren't chargeable, and rounding down would leave us
 * fractionally short of cost on every single job. The <1¢ residual is the granularity of money, not margin.
 *
 * Returns 0 when there's nothing billable, so a fully-allowance-covered job is free rather than a charge.
 */
export function quoteCents(thawBytes: number, egressBytes: number): number {
  const thaw = Number.isFinite(thawBytes) && thawBytes > 0 ? thawBytes : 0;
  const egress = Number.isFinite(egressBytes) && egressBytes > 0 ? egressBytes : 0;
  if (thaw === 0 && egress === 0) return 0;

  const awsUsd =
    (thaw / BYTES_PER_BILLED_GB) * GDA_BULK_THAW_USD_PER_GB + (egress / BYTES_PER_BILLED_GB) * EGRESS_USD_PER_GB;
  const grossUsd = (awsUsd + PADDLE_FIXED_USD) / (1 - PADDLE_RATE);
  return Math.ceil(grossUsd * 100);
}

/**
 * The part of a restore the user actually pays for: the requested bytes minus whatever allowance is left
 * in the current window. `allowanceRemaining` is computed from the last `ALLOWANCE_WINDOW_DAYS` of this
 * account's allowance-covered restores (see `routes/retrieval.ts` — the jobs table IS the ledger, so
 * there's no second counter to drift out of sync).
 *
 * Measured in EGRESS bytes — what the user asked to get back — never in thaw bytes. This matters: one
 * 5 MB photo can require thawing the whole 1 GiB blob it sits in, and charging that against a 200 MB
 * allowance would consume the entire month's allowance to return a single photo. That would defeat the
 * only thing the allowance exists to do. The thaw cost of an allowance-covered restore is simply eaten —
 * fractions of a cent, and it belongs to the same acquisition-spend line the free tier already sits on.
 *
 * Applied as a DISCOUNT on the bytes, not an all-or-nothing gate: a 1.5 GB restore against a 1 GB
 * allowance bills the 0.5 GB overage, not the whole job. A cliff ("your 1.01 GB restore costs full
 * price") is exactly the kind of petty surprise the plain voice forbids.
 */
export function billableBytes(egressBytes: number, allowanceRemaining: number): number {
  return Math.max(0, egressBytes - Math.max(0, allowanceRemaining));
}
