# Retrieval billing — engineering spec

> **Status: EXPLORING** · 2026-07-12 · provisional
> Records our thinking as of the date above — NOT a contract. Before acting on anything
> here, confirm it still matches the current goal. When it conflicts with where we're
> actually headed now, the current goal wins: flag the conflict, don't silently obey.

The engineering half of PROD.md's "retrieval pass-through steel thread" (phase A of the
free-tier plan). The pricing/margin model behind it is private (`strategy/retrieval-economics.md`);
this doc never needs those numbers — the backend quotes a price, everything else treats it as
opaque cents.

## Decisions in force [settled 2026-07-12, Ben]

- Restores are billed **at cost** (a pass-through, including payment-processing overhead), for
  every account, free and paid. Margin is made on storage only.
- A **small free rolling allowance** (size TBD in `strategy/`) makes tiny restores — a photo, an
  album — cost nothing and need no checkout. Material restores get one quote → one payment.
- **No credit/balance system in V1.** Considered (2026-07-12) and deferred: a stored-value
  ledger + unspent-balance liability isn't warranted by cold-archive retrieval patterns
  (bimodal: tiny-and-cheap vs. rare-and-big). All options need the same metering plumbing, so
  credits can drop in later if real usage shows a mid-size pattern.
- Same **soft-gate posture** as deposits/quota: the daemon/app enforce; IAM does not (the hard
  gate remains the same deliberately-deferred, separate step it's always been).

## The flow (steel thread — prove this end-to-end in sandbox first)

```
app picks files to restore
  → daemon sizes the job from the journal's blob sizes (no S3 call needed)   [assumption A1]
  → within the rolling allowance? → proceed now; report usage to backend (metering)
  → else: backend POST /restore-quote {bytes} → {cents, quoteId}
      → payment:
          subscriber: one-time charge against the saved Paddle payment method [open O1]
          free user:  hosted checkout with an inline one-time price           [open O2]
      → transaction.completed webhook marks the quote PAID
  → app polls the job; daemon starts the S3 restore (bulk tier) only for a PAID job
  → GDA restore completes (~48h) → daemon downloads → done
```

Wire sketch (shapes, not contracts yet): backend `POST /restore-quote`, `GET /restore-jobs/:id`,
webhook handling for the one-time transaction; a restore-jobs table (quote → paid → started)
plus a per-account rolling usage counter; daemon control commands to size a job and to gate
`restore` on a paid/allowed job id.

## Open questions — resolve while building the thread, update this doc as they settle

- **[open O1]** Charging a subscriber's saved payment method without a checkout — expected to be
  Paddle's one-time charge on an existing subscription (`subscriptions` one-time charge API);
  verify mechanics + failure modes against current Paddle docs at build time.
- **[open O2]** Free users have no payment method on file — hosted checkout with an inline
  (non-catalog) one-time price carrying `customData: { cognitoSub, quoteId }`. Verify inline
  one-time prices on `transactions.create` and Paddle's minimum-charge floor.
- **[open O3]** Allowance accounting lives backend-side (daemon-reported bytes — consistent with
  the soft-gate trust model). Multi-device races can double-spend an allowance window; accepted
  for a soft gate, but say so in code comments.
- **[open O4]** Mid-job failure/refund story: quote paid but restore fails permanently → refund
  via Paddle (MoR owns the mechanics); define what the app shows. Partial downloads: the job is
  priced on requested bytes at quote time — no metering true-up in V1. [assumption]
- **[open O5]** Restore tier: bulk only (~48 h, cheapest) in V1; standard (~12 h) later as a
  priced choice. The quote/UX copy must set the 48 h expectation plainly (calm, factual).
- **[assumption A1]** The journal's blob records carry ciphertext sizes accurate enough to price
  a job (egress is billed on actual bytes; blob framing overhead is ~fixed per blob). Verify
  against `Journal` schema before trusting.

## Explicitly out of scope (V1)

- Credit/balance system (see Decisions above — revisit only on real usage data).
- Hard IAM-layer enforcement of restore payment.
- Retrieval pricing shown on the marketing site (site copy is a phase-C surface; this doc is
  plumbing only).
