# Paddle — ops SSOT

ColdStorage bills through **Paddle (Merchant of Record)**. Seller of record: **Ben Honda, sole
trader**, trading as **ColdStorage**. This file is the durable record of the live setup — the
product catalog (price ids), how to reseed it, and what's wired where.

> Price ids and client tokens are **non-secret** (they're exposed at checkout by design), so they
> live in the repo. The **API key** and **webhook secret** are secret and never belong here.

## Seller onboarding (reference)

- **Business type:** Individual / Sole Trader → skips Paddle's business-verification phase.
- **Trading name:** ColdStorage · **Legal name:** the registered sole-proprietor name (must match
  the site Terms exactly — the #1 avoidable rejection).
- **Product category:** SaaS / subscription software.
- **Website:** `https://www.coldstorage.sh` (canonical is `www`).
- **Required legal pages (live, linked in footer):** `/terms` · `/privacy` · `/refunds` · `/pricing`.

## Live product catalog

`[reshaped 2026-07-12, superseding the 3×4/12-price matrix below]` **5 products (storage sizes),
one annual recurring price each = 5 prices.** Tax category **`saas`**. No terms — annual only, no
multi-year discount (SPEC.md §5). Pricing mirrors `account-backend/src/plan-sizes.ts` (the true
SSOT) / `site/app/lib/marketing/content.ts` (marketing display — **upstream-owned, pull-managed**,
not in scope for the reshape below; see "Site marketing copy" note). Quantity capped at 1; no
trial (the 14-day money-back guarantee is a refund, not a Paddle trial).

| Size | Amount | Price id |
|---|---|---|
| 500 GB | $9.99 | `pri_01kx2h5hb2w0vmc2ppb8e6gvkr` (existing, unchanged) |
| 1 TB | $18.99 | `pri_01kx2h5hx31s3b9rvb5mq71ryf` (existing, unchanged) |
| 2 TB | $36.99 | `pri_01kx2h5jf1sp2n5bxx8dt521yv` (existing, unchanged) |
| 5 TB | $90.99 | *(not yet created — run the seed with `--apply` to get the real id)* |
| 10 TB | $180.99 | *(not yet created — run the seed with `--apply` to get the real id)* |

> Sandbox has its own separate catalog with **different** price ids (created the same way).

**Migration note:** the old 2/3/5-year prices (9 of them, 3 per size) are now off-SSOT — they're
still active in Paddle (existing subscribers keep renewing on them; Paddle entities can't be
hard-deleted) but should be archived so they stop showing as sellable. `--archive-extras` already
identifies exactly these 9 as strays (verified via a PLAN run against sandbox 2026-07-12) — see
"(Re)seed the catalog" below for the exact commands, sandbox first.

## (Re)seed the catalog

`account-backend/scripts/seed-paddle-catalog.ts` (via `task backend:paddle:seed`) creates this
catalog idempotently — pricing is derived from the SSOT above, so it can't drift. Both keys can
sit in your shell at once; the **required `--env` flag** picks the target account, and the key's
prefix (`pdl_live_…` / `pdl_sdbx_…`) is asserted against it so a wrong-slot key fails loudly.

```sh
export PADDLE_API_KEY='<live key with product + price write scope>'    # never commit these
export PADDLE_API_KEY_FOR_SANDBOX='<sandbox key, same scope>'
task backend:paddle:seed -- --env sandbox                                        # PLAN (read-only) — review, confirm the header
task backend:paddle:seed -- --env sandbox --apply                                # WRITE (idempotent — safe to re-run): creates 5TB/10TB
task backend:paddle:seed -- --env sandbox --apply --archive-extras               # + archives the 9 old term prices
task backend:paddle:seed -- --env production --apply --archive-extras           # same, against the LIVE account
```

Add `--archive-extras` to also retire active entities **outside** the SSOT (products with off-SSOT
names, prices with off-SSOT billing cycles) — archiving blocks new checkouts but existing
subscriptions keep renewing. Plan-gated like the rest: without `--apply` it only lists the strays.
Used 2026-07-10 to retire the original hand-made sandbox catalog after seeding the canonical one;
**needed again now** (2026-07-12 reshape) to retire the 9 old 2/3/5-year prices per size — a PLAN
run against sandbox already confirms it identifies exactly those 9 and nothing else.

Tax category defaults to `saas` (override with `PADDLE_TAX_CATEGORY=…`). Non-default categories
must be approved first in **Paddle → Catalog → Taxable categories**.

## Wiring status

- **Multi-plan checkout (2026-07-10):** `checkout-session.ts` sells whichever `priceId` the app
  sends, validated against the live catalog served by `GET /catalog` — no per-stack default price
  exists anymore (`PADDLE_PRICE_ID` retired from TF + the env schema; see "Multi-plan picker" below).
- **Client-side tokens: DONE, both environments** (minted via `task backend:paddle:client-token`,
  idempotent). Values live in TF: `infra/site` `PUBLIC_PADDLE_CLIENT_TOKEN` + `infra/account-backend`
  `paddle_client_token`, production & staging. Empty ⇒ `/checkout` errors.
- **Catalogs reconciled 2026-07-10:** sandbox reseeded to the (then-canonical) 3×4 shape and the
  original hand-made sandbox catalog archived (`--archive-extras`) — both accounts now differ only
  by ids. **Superseded 2026-07-12:** canonical shape is now 5 sizes × 1 annual price each (no
  terms); code + SSOT updated and PLAN-verified against sandbox, `--apply` still pending (needs
  Ben's live API keys — not run from this session).
- **Webhook destinations (both live, same nine `subscription.*` events):**
  - sandbox → `https://api-staging.coldstorage.sh/webhooks/paddle` (`ntfset_01kwhna1zqe98w8q7zr99by1dp`, 2026-07-02)
  - live → `https://api.coldstorage.sh/webhooks/paddle` (`ntfset_01kx68ekrpz6fzjt9jjr7zy9rf`, 2026-07-10, created
    via the API mirroring the sandbox destination's event list)

  Each destination's endpoint secret is that stack's `PADDLE_WEBHOOK_SECRET` in Vercel (set by hand
  in the dashboard — the TF convention for manual secrets). Both were set for real as of 2026-07-10.

## Runtime key scope

The `PADDLE_API_KEY` the deployed backend runs with is a **dedicated scoped key**, not the
full-permission ops key (which stays in the shell for the scripts above). Required scope — BOTH
environments' keys (edit permissions in the dashboard; the key string doesn't change, so no
Vercel/redeploy step):

- **Transactions: read + write** — checkout (`transactions.create`; the 5c war story: a
  zero-permission key fails here).
- **Subscriptions: read + write** — the manage surface (`subscriptions.get`/`previewUpdate` read,
  `subscriptions.update` WRITE). War story #2 (2026-07-10): the staging key had read but not
  write — `GET /subscription` + the proration preview worked while the actual plan change 500'd
  with `forbidden: not authorized to read|update subscription`.
- **Products: read + Prices: read** — the `GET /catalog` route.

Nothing else (webhook verification is local HMAC — no permission). If the key was created with an
expiry, note the rotation date here when it's known.
## Managing a subscription — BUILT ✅ (2026-07-10)

The account card's manage surface (sidebar bottom-left → Settings ▸ Account). Split of
responsibilities, decided 2026-07-10:

- **Cancel + update payment method → Paddle-HOSTED pages.** The subscription entity's
  `managementUrls` (verified in the installed SDK types, `SubscriptionManagement`), fetched fresh
  per click and opened in the system browser. Paddle is the MoR — its pages own the
  confirm/effective-date/refund UX; we build none of it.
- **Plan change (size) → in-app.** The same `PlanPicker` as checkout, seeded with the current
  plan → `POST /subscription/change/preview` (Paddle `previewUpdate`) puts the money on the table
  ("charged $X now" / "$X credit toward future bills") → `POST /subscription/change` applies with
  `prorationBillingMode: "prorated_immediately"` + `onPaymentFailure: "prevent_change"` (Paddle's
  default, pinned explicitly): an upgrade whose prorated charge fails does NOT apply — no
  upgrade-without-paying. Price ids are catalog-validated like checkout.
- **Current plan** → `GET /subscription`: live `subscriptions.get` summarized against the catalog
  (status, plan, nextBilledAt, cancelsAt, management URLs). Nothing plan-shaped is duplicated into
  the DB — the row only supplies the subscription id; `subscriptionActive` stays webhook-fed.

Code map: backend `src/routes/subscription.ts`; app `EntitlementManager.{getSubscription,
previewPlanChange,changePlan,openManage}` → IPC `entitlement:{subscription,previewChange,
changePlan,openManage}` → `AccountCard` (sidebar) + Settings ▸ Account rows + `ChangePlanModal`.

## Multi-plan picker — BUILT ✅ (2026-07-10, per this spec; term selector removed 2026-07-12)

The picker lets a signed-in user choose a size and check out the right one of the (now 5, annual)
prices. Built as one unit across all four layers below (it couldn't ship half-built without
breaking the old single-price checkout — which is now gone: `PADDLE_PRICE_ID` is deleted from the
backend env schema and retired from TF). Code map: backend `src/catalog.ts` (pure mapping + tests) /
`src/catalog.server.ts` (TTL cache) / `src/routes/catalog.ts` + the `priceId` validation in
`src/routes/checkout-session.ts`; app `EntitlementManager.getCatalog()`/`subscribe(priceId)` →
IPC `entitlement:catalog` → `SubscribeModal`. **Still pending: Ben's on-Mac visual + sandbox
checkout verify** (against the reshaped 5-tier catalog, once seeded).

The decided spec, kept for reference (what's built matches it):

**UX** (in `ui/.../SubscribeModal.tsx` → shared `PlanPicker.tsx`, DS-bound):
- **Size** = five cards (the only choice now — no term axis), each showing size + annual price
  (`1 TB · $18.99/yr`). No usage-based nudge (decided: neutral pick). Default-select **1 TB**.
- **Live price** below = annual total + per-month equivalent (`$18.99 · $1.58/mo`).
- Button `Subscribe to <size>`. `[terms removed 2026-07-12]` the old "term segmented row" and
  "longer terms lock today's rate" line are gone along with multi-year terms (SPEC.md §5). Keep
  the existing "already-stored stays restorable" reassurance.

**Backend** (`account-backend/src`):
- `GET /catalog` — fetch live via `paddle.prices.list()` (active prices under our products), map to
  `{ size, years, priceId, amountCents, perMonth }`, cache in-memory with a short TTL. This is the
  SSOT the app renders (no hardcoded id map — stays DRY, works sandbox + prod, self-updates). The
  `years` field stays in the shape (harmless — always `1` post-reshape) rather than a churn-y type
  change for no behavioral gain.
- `checkout-session` — accept `{ priceId }`, **validate it's in the fetched catalog** (reject unknown
  ids — never trust a client-sent price), then create the txn with it + `customData.cognitoSub`.
  Replaces the hardcoded `env.PADDLE_PRICE_ID`.

**IPC/main + renderer** — add a "get catalog" IPC; thread the chosen `priceId` through the existing
checkout IPC into `POST /checkout-session`.

## Site marketing copy — NOT updated here, needs an upstream design pass

`site/app/lib/marketing/content.ts`'s `TERMS`/`MATRIX`/`RATE_LOCK` (the public `/pricing` section)
still show the old 3-tier/4-term shape. That file is explicitly **verbatim-ported from an upstream
Claude-cloud design project** (its own docstring: "do not paraphrase or improve it here; edit it
upstream and re-pull"; `site/SPEC.md`: "copy + the pricing matrix are already written and voiced
upstream") — hand-editing it here would fight that pipeline and get reverted on the next pull. The
5-tier annual-only ladder (SPEC.md §5) needs to go through the upstream design session before a
re-pull updates this file; not done as part of the 2026-07-12 reshape.
