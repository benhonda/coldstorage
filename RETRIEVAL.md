# Retrieval billing — engineering spec

> **Status: DRAFT** · 2026-07-13 · built, not yet exercised end-to-end
> Records our thinking as of the date above — NOT a contract. Before acting on anything
> here, confirm it still matches the current goal. When it conflicts with where we're
> actually headed now, the current goal wins: flag the conflict, don't silently obey.
>
> All four layers (infra, backend, daemon, UI) are BUILT and green; the infra is APPLIED.
> What has NOT happened: a real restore priced, paid and thawed end-to-end against Paddle
> sandbox. Until that runs, treat the flow below as designed-and-typechecked, not proven.

The engineering half of PROD.md's "retrieval pass-through steel thread" (phase A of the
free-tier plan). The pricing/margin model behind it is private (`strategy/CANON.md` §7);
this doc never needs those numbers — the backend quotes a price, everything else treats it as
opaque cents.

## Decisions in force [settled 2026-07-12, Ben]

- Restores are billed **at cost** for every account, free and paid — **0% margin, and we subsidize
  nothing**: the quote recovers AWS's retrieval + egress AND both halves of Paddle's fee (5% +
  $0.50). We absorb costs only where margin exists to absorb them (subscriptions); retrieval has
  no margin, so it recovers exactly. Formula + worked numbers in
  `strategy/CANON.md` §7; effectively ~$0.0974/GB + ~$0.53 per retrieval. Compute the
  quote exactly — do NOT round the per-GB rate up to a clean number, that books margin on
  retrieval. The backend owns this math; the daemon and app treat a quote as opaque cents.
- A **small free rolling allowance** makes tiny restores — a photo, an album — cost nothing and need
  no checkout. Material restores get one quote → one payment. **Sizes DECIDED (2026-07-13, Ben):
  1 GB per 30-day window on a paid plan, 200 MB on the free tier** (`retrieval-pricing.ts`:
  `ALLOWANCE_BYTES_SUBSCRIBED` / `ALLOWANCE_BYTES_FREE`). The paid allowance is funded by storage
  margin; the free one is booked as acquisition spend, the same line the 25 GB free tier sits on.
- **No credit/balance system in V1.** Considered (2026-07-12) and deferred: a stored-value
  ledger + unspent-balance liability isn't warranted by cold-archive retrieval patterns
  (bimodal: tiny-and-cheap vs. rare-and-big). All options need the same metering plumbing, so
  credits can drop in later if real usage shows a mid-size pattern.
- **A HARD GATE — the thaw is the gate. [settled 2026-07-13, Ben: "build the real, robust fix"]**

  The problem it solves: everywhere else in this system a soft gate is fine, because a bypass is
  bounded and cheap (a tampered client can over-deposit, costing ~$1/TB/mo of storage from someone
  already paying us). Retrieval is not like that. The user's Cognito role used to hold
  `s3:RestoreObject` alongside `GetObject`, so their own credentials could thaw and download the
  entire vault without ever calling this backend — while **we pay the egress regardless**
  ($0.09/GB out of our bucket; a 2 TB vault ≈ $185 of our money, possibly from a free-tier user
  paying us nothing). Unbounded and unrecoverable is a different risk class, and the quota gate's
  "soft is fine" reasoning does not carry over.

  **The mechanism.** A Deep Archive object cannot be read at all until it is thawed —
  `GetObject` against a cold object fails with `InvalidObjectState` (verified against AWS docs,
  2026-07-13). So `s3:RestoreObject` was **removed from the user role** and granted **only to the
  account-backend's Vercel OIDC role**, which performs the thaw exclusively for a job that is
  `paid` or `allowed`. The user cannot thaw; therefore the user cannot read; therefore the charge
  is enforceable rather than advisory. A tampered client gains nothing — there is nothing to tamper
  with.

  `s3:GetObject` deliberately STAYS on the user role: it is also what authorizes HeadObject, which
  the daemon needs for `verify()` (post-upload) and `thawState()` (polling). It is inert against a
  cold object, so it is safe — **the thaw is the gate, not the read.** This is why no presigned-URL
  machinery is needed (an earlier draft's plan): the daemon keeps its direct ranged-GET download
  path untouched, and only its *thaw* moves to the backend.

  **Zero-knowledge is untouched.** The backend gains `RestoreObject` + `GetObject` (for HeadObject
  sizes) on `blobs/*` — ciphertext metadata only. It never reads an object body, and could not
  decrypt one if it did: the MasterKey never leaves the device. Egress still flows S3→client
  directly, so mediating the thaw costs us nothing extra.

  **Trust boundaries, all server-side:** blob OWNERSHIP is proved against the caller's real
  Identity-Pool id (resolved from their verified ID token via Cognito `GetId` — never accepted from
  the client, or a caller could make us thaw a stranger's archive at our expense), and blob SIZES,
  which set the thaw price, come from `HeadObject` — never from the request body, or a client could
  price a 2 TB restore at 53¢.

  Landed: `infra/coldstorage` (−`RestoreObject`, plan: 0 add / **1 change** / 0 destroy),
  `infra/account-backend` (+S3 thaw policy on the OIDC role, +2 env vars; plan: **3 add** / 0 / 0),
  `aws.server.ts`, `identity.server.ts`, `retrieval.server.ts` (`blobSizes` + `thawBlobs`),
  quote/webhook wiring. **Both TF applies are pending Ben.**

## The flow

```
app picks files to restore
  → daemon resolves the BLOB KEYS + egress bytes from the journal            [daemon: TODO]
  → POST /retrieval/quote { blobKeys, egressBytes }
      → backend proves the keys are the caller's (Cognito GetId → blobs/<identityId>/…)
      → backend HeadObjects each blob for its TRUE size (a thaw is billed on whole objects)
      → inside the free rolling allowance? → job `allowed`, thawed at once, no payment
      → else → job `quoted` (thaws NOTHING)
  → POST /retrieval/jobs/:id/pay
      → subscriber: Paddle one-time charge against the saved card (no checkout)
      → free user:  hosted Paddle checkout URL, opened in the system browser
  → `transaction.completed` webhook → THAW the job's blobs → job `paid`      ← THE GATE
  → daemon polls S3 HeadObject (its own creds still allow this) until thawed (~48 h, bulk)
  → daemon ranged-GETs the ciphertext + decrypts locally → done
```

## What's built (2026-07-13) — all green: backend 27, daemon 89, UI 110 tests

- **infra** — `s3:RestoreObject` removed from the Cognito user role; granted to the backend's Vercel
  OIDC role, scoped to `blobs/*`. **APPLIED** (both plans verified clean afterwards).
- **backend** — `retrieval-pricing.ts` (the 0%-margin SSOT, thaw + egress priced separately),
  `identity.server.ts` (Cognito `GetId` → ownership check), `retrieval.server.ts` (`blobSizes`,
  `thawBlobs`, the two Paddle payment paths), `routes/retrieval.ts`, the `transaction.completed`
  webhook, and the `retrieval_jobs` table (which doubles as the allowance ledger).
- **daemon** — `RestoreStep.next` (pure, tested: a daemon that cannot thaw NEVER decides to thaw),
  the `.authorizationRequired` outcome, and a `restorePlan` command that maps fileIds → deduped blob
  keys + egress bytes for the quote. Dogfood still self-thaws (its IAM user kept `RestoreObject`).
- **UI** — `quoteRestore`/`payForRestore`/`getRestoreJob`/`cancelRestore` through manager → IPC →
  preload; `RequestBackModal` now shows the BACKEND's price (quote → pay → restore).

## The pricing-SSOT cleanup (2026-07-13) — one price, from the party that charges it

The app used to price a restore from the **daemon's rate card**, which quotes AWS's *thaw* rate with no
egress (36× bigger), no payment fee, and no knowledge of the free allowance — understating the real
charge by **~40×**. The same rate card also drove a "Roughly ~$X/month" line in Settings that showed a
paying customer **our AWS cost**, not their bill.

Both were honest when Ben was the only user and paid AWS directly. They became lies the moment the
product had a real price, and nobody re-audited them when billing landed. That drift — *a dogfood-era
number quietly turning customer-facing* — is the actual failure mode, and it's worth naming because it
is not the same thing as a DRY violation.

So the rate card is **gone**, not just unused:
- deleted: Swift `Pricing` enum + `RestoreTier.retrievalUsdPerGB`, the daemon's `getPricing` command and
  its DTOs, the UI's `Pricing`/`TierQuote` types, `views/files/pricing.ts` (whole module), the store's
  `pricing` slice, the Settings cost line, and the `getPricing` check in `prove.ts`.
- a restore price now has exactly one source: `POST /retrieval/quote`.
- **`typicalWait` ("~48 hours") moved to the backend too** — it picks the bulk tier, so it is the only
  party that can honestly state the wait. (The app had briefly hardcoded it: the same bug, in miniature.)

Tombstone comments sit where each deleted thing was, so the next person reaches for the backend instead
of rebuilding a local estimate.

## Settled while building (2026-07-13)

- **Subscriber charge** — `paddle.subscriptions.createOneTimeCharge(subId, { effectiveFrom:
  "immediately", items: [an inline non-catalog price] })`. It resolves with the SUBSCRIPTION, not the
  transaction it spawns, so there is no transaction id to link a job by: linking runs through the
  inline price's `customData.retrievalJobId`, which works identically for both payment paths.
- **Free-user charge** — `transactions.create` with the same inline price → hosted checkout URL.
- **Both** hang off one real Paddle product, `ColdStorage — Data retrieval` (`RETRIEVAL_PRODUCT_NAME`
  in `plan-sizes.ts`): created by the seed script, excluded from the plan catalog, and protected from
  `--archive-extras`. It carries NO catalog prices — a restore's price is a function of its bytes, so
  there is no finite set of prices to enumerate.
- **Webhook ordering is load-bearing:** thaw FIRST, mark `paid` SECOND. The reverse strands a paying
  user's data cold forever if the thaw fails — Paddle's retry would find a job already marked paid and
  do nothing. `thawBlobs` is idempotent, so retrying after a partial failure is free.
- **Bulk tier only** (~48 h, cheapest). The quote is priced at bulk rates, so silently requesting a
  faster tier would spend money we never charged for. Standard (~12 h) can come later as a priced
  choice. App copy must set the 48 h expectation plainly — factual, no apology, no drama.
- **Thaw window: 5 days** — enough for a 48 h bulk thaw plus the user collecting on their own
  schedule. A later re-thaw is a new job, and correctly a new charge.

## Open

- **[open]** Minimum charge — cards have a floor and a 1 GiB restore quotes at ~62¢. Verify Paddle's
  real floor on the first sandbox charge and set the minimum to exactly it, never above (a minimum
  above the floor is margin, which the 0% rule forbids).
- **[open]** Refunds: a job paid whose thaw permanently fails → refund via Paddle (the MoR owns the
  mechanics). Decide what the app shows. Not V1-blocking, but it is a real path.
- **[accepted]** Allowance double-spend race: two devices quoting at the same instant each see the
  full allowance. Worst case is one extra window (~2¢ of egress); locking the account row on every
  quote would add hot-path contention to defend two cents.
- **[accepted]** Within the 5-day window a user can re-download — or over-download — a blob they paid
  to thaw, bounded by that blob (≤1 GiB). Closing it would mean billing every restore on whole-blob
  bytes, which would let a single photo consume a free user's entire monthly allowance.

## Explicitly out of scope (V1)

- Credit/balance system (see Decisions — revisit only if real usage asks for it).
- Retrieval pricing on the marketing site (a phase-C surface; this doc is plumbing).
