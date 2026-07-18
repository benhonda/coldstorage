# ColdStorage Marketing Site — Build & Sync Spec

> **Status:** ✅ LIVE at [coldstorage.sh](https://coldstorage.sh) (2026-07-05) · Phases 1–4 done.
> **Landing page recomposed from upstream 2026-07-18** — new positioning, new pricing model,
> six new sections (see *What ships* → *2026-07-18 re-pull*). typecheck + build green, SSR
> output verified.
> **Company + support pages added 2026-07-18** — `/about`, `/source`, `/help`, `/contact`,
> killing the footer's four dead links. `/contact` is the app's first `action` (Turnstile → zod
> → CD2). typecheck + copy-check + build + `task ssr:check:site` all green.
> Pending: **hero + drag-in media are placeholders**, the privacy/key-escrow claim needs a
> product call, OIDC-trust re-apply (`coldstorage-web` slug), live Paddle token for prod
> checkout, **two copy lines await Ben's confirmation**, **`infra/site` TF plan unverified
> (pharmer SSO expired)** — see **Open decisions** and **Phases** below.
> This spec is a living document, not scripture. If the code and this file disagree, the code wins
> — fix the file.

## Goal

Stand up the ColdStorage **marketing site** (`coldstorage.sh`) as an RR7/adpharm-stack app
that renders with the ColdStorage **Design System**, carries marketing sections **designed
upstream** in Claude cloud design, and **hosts the checkout page** — with a sync mechanism
that keeps upstream design and repo code aligned **without hand-maintained duplication**
(PILLAR3).

## Where it lives · stack

- **Location:** `site/` (monorepo subdir — `ui/` and `account-backend/` already exist). The
  root `Taskfile.yml` stays the one command surface; `site` gets dir-scoped tasks
  (`start:site` / `link:site` / `pull:site`; the design-mirror pull is an **agent action**, not a
  task — DesignSync is session-only, see the sync loop below), and the bare
  `start`/`link`/`pull` become app pickers over `ui` / `backend` / `site`.
- **Stack:** RR7 (SSR) on Vercel, `~/*`→`app/*`, Tailwind v4, zod fail-fast env, its **own
  Vercel project** + **`infra/site/`** Terraform (prod + staging), package/state name
  `coldstorage-site` (from devcontainer `name: coldstorage`).
- **Theming:** **light-only** — the DS defines no dark tokens, and code must not invent them
  (that would recreate the drift we're killing). Keep the no-flash engine, pin to light;
  revisit only if the DS defines dark upstream.
- **i18n:** en/fr on from the start (`/fr` convention); the upstream copy module is the source.

## The four layers · one owner each (this is what kills drift)

| Layer | What | Single source of truth | Sync direction |
| --- | --- | --- | --- |
| **A. Tokens** | color / type / spacing / effects / radius / shadows | **pinned snapshot `_ds/…41ebafc1`** (verbatim, pull-managed → `app/styles/ds/`); `739a…` = origin to reconcile | code pulls down; a thin shadcn-alias layer maps DS vars → shadcn names |
| **B. DS components** | Button, Card, Input, Nav, Footer… | **DS project `739a…`** component source | pulled down; not shared with Electron (coherence = shared tokens, not shared code) |
| **C. Marketing sections** | hero, how, privacy, pricing, faq, closing — **layout only** | **marketing project `942990bc…`** (design) → repo `.tsx` (impl) | pull-only → mirror → agent-translate |
| **D. Copy** | every word the site renders | **`app/lib/marketing/content.ts`** — authored here, not derived | none — it is the source |

### Layer D — copy ownership (settled 2026-07-18)

Copy was previously drafted in `strategy/*-copy.md` (gitignored, private). That put the same
words in **five** places — strategy doc → design-project upload → the design's `LC` object →
`design-mirror/` → `content.ts` — with nothing declaring a winner. They drifted, and a page
shipped with invented headings that appeared in no doc.

**`strategy/` no longer prescribes artifacts.** It is for high-level thinking and what's next.
Shipped copy is public words; it belongs in version control where it is reviewed in diffs.

| Question | Owner |
| --- | --- |
| What a page **argues** (framing) | `strategy/landing-framing.md` |
| How it **sounds** (voice) | `strategy/BRAND-VOICE.md` + the `ben-prose` skill |
| The actual **words** | **`app/lib/marketing/content.ts`** |
| **Prices** | `account-backend/src/plan-sizes.ts` + `retrieval-pricing.ts` (code) |
| **Legal prose** | `app/lib/marketing/legal.ts` (own SSOT, own review path) |

**The design project's copy is a preview fixture, never a source.** `shared/landing-copy.jsx`
(`LC`) and `shared/site-common.jsx`'s dead `CS_*` constants are mirrored verbatim so design
diffs stay clean and the upstream previews render — they are *not* consulted for wording, and
they will lag. Layer C pulls **layout** from upstream; it does not pull words.

Standing copy constraints (in the `content.ts` header, so they travel with the words): never
name the backend provider in customer copy (legal disclosure is the carve-out); no
fear-mongering or "safe"/"secure" claims; never claim past what the architecture does.

**Published prices are the REAL prices, never tidied.** Retrieval runs at **0% margin**
(`retrieval-pricing.ts`), so a rate rounded *down* is a subsidy paid out of storage margin and
one rounded *up* is margin we said we don't take. **$0.0974 is not $0.10; $0.53 is not $0.50.**
The same number must appear everywhere it appears at all.

> _Fixed 2026-07-18:_ the site published **$0.09/GB and $0.50 flat** — the raw AWS egress cost
> with the thaw and Paddle gross-up stripped off — and promised retrieval "sooner if you pay a
> bit to hurry it" when **bulk is the only tier V1 sells**. All three were wrong; the fine print
> ("plus card processing… never rounded up") was wrong in both halves too. Now derived from
> `quoteCents()`, which is exactly what the guard below exists to prevent recurring.

**`task copy:check:site` enforces the non-negotiable parts** (`site/scripts/copy-check.ts`), so
the churn can't quietly break them. Seven rules: plan prices mirror `PLAN_SIZES` (yearly +
derived monthly); **retrieval rates and the free allowance are re-derived from `quoteCents()`**,
not compared to a hardcoded copy; the provider is never named; no "safe"/"secure"/"guaranteed"
over-claims; "encrypted" never "scrambled"; never framing our own cost as nothing;
`/how-it-works` carries no dollar figures; and `PRICING.readyNote` still sets the not-instant
expectation — cutting it is a regression, not an edit. Run it after touching copy. It is *not* a
spell-check on the words; copy stays free to change, which is the point.

**Why C's two representations aren't a DRY violation:** the upstream `.jsx` is the *design
contract* (visual judgment), the repo `.tsx` is the *implementation* (types, i18n, routing,
real DS components) — same split as Figma-vs-code. The only thing we refuse to duplicate is
**token values**, and those travel verbatim.

## Upstream projects

| Project | ID | Type | Sync mode |
| --- | --- | --- | --- |
| Cold Storage Design System | `739a4170-fac2-4727-a1e9-aa1b10705b35` | `DESIGN_SYSTEM` | round-trip capable (pull-dominant) |
| Modern 2026 marketing website | `942990bc-2bee-4b0b-85b0-331bf79cf37f` | `PROJECT` | **pull-only** (correct — design lives upstream) |

The marketing project vendors a **pinned DS snapshot** under
`_ds/coldstorage-design-system-41ebafc1…/` (like a lockfile). The site is built against the
snapshot the design actually uses; `739a…` is the origin the snapshot publishes from.

**Confirmed skew (2026-07-05):** the pinned snapshot has diverged from the current `739a…`
tokens — the snapshot is the "frost + iceberg" system (`--bg-app`, `--accent`, `--frost-*`,
fluid `clamp()` type/space scales, `--type-*`, `--section-y`) that every section consumes;
`739a…`'s current `colors.css` is an older warm-gray/`--ink` lineage. **Build against the
snapshot** — it is Layer A's effective SSOT. Tokens are pulled **verbatim** to
`site/app/styles/ds/*.css` (pull-managed, header-marked "do not edit"), so the mirror and the
app copy are the same bytes and there's no second hand-maintained owner. Reconciling snapshot
↔ `739a…` origin is a later, separate concern.

**Fonts:** the snapshot loads Hanken Grotesk / JetBrains Mono / Material Symbols via Google
Fonts `@import` (design-preview convenience). For production, move to `<link rel="preconnect">`
+ stylesheet or self-host (Fontsource) — a Phase 2 perf refinement, not a Phase 1 blocker.

> **Tooling note:** `DesignSync` is available only in the **top-level session**, not in
> spawned subagents. The mirror pull is therefore run by the orchestrator, incrementally.

## The sync loop

1. **Pull — mechanical, but agent-run.** DesignSync is a session-only tool (no CLI), so the
   pull is an **agent action**, not a shell `task`: the orchestrator calls DesignSync `get_file`
   and writes upstream files **verbatim** into `site/design-mirror/` (the committed
   design-of-record). No translation. Its job is to make any upstream change land as a
   **reviewable git diff**. (Verbatim tokens land directly in `app/styles/ds/` — one copy, see Layer A.)
2. **Translate + integrate — an intelligent agent.** Converting mirror `.jsx` (inline styles,
   `window.*` globals, browser-Babel) → stack `.tsx` (ES modules, typed content, i18n, real DS
   components, SSR) requires judgment. Done first-time and on each re-pull.
3. **Bounded re-sync.** The mirror diff scopes the agent to just what changed. The seam is
   engineered so high-frequency churn stays near-mechanical:
   - **copy/pricing** → a typed content module (also the i18n source): data edits
   - **tokens** → verbatim; the alias layer absorbs them: zero judgment
   - **reorder / variant swap** → edit the page's section list: mechanical
   - **a section's visual internals** → the only real agent-judgment case (as it should be)
4. **Translation contract.** The mapping rules (window-globals→imports, `site-common`→typed
   content+i18n, DS-bundle components→our DS components, `csInjectStyle`→CSS) are written down
   once (a short project skill / mirror README) so every re-sync applies the *same* rules —
   agent-assisted, not improvised. Review-gated by design (never auto-overwrite a live site).

## What ships (the Master composition)

Six sections + chrome. Everything else upstream is **alternates** (3 heroes, 7 how's, …) —
kept upstream as the design library, not ported:

`MarketingNav` → `HeroStatement` → `DragIn` → `PrivacyLedger` → `PricingTabbed` →
`FaqSplit` → `ClosingBand` → `MarketingFooter`.

Upstream composes these from three files, and our section names carry the lineage:
`v4-sections.jsx` (hero, drag-in, close), `v3-sections.jsx` (privacy), `master-sections.jsx`
(pricing, FAQ).

Copy is **written and voiced** upstream in **`shared/landing-copy.jsx`** (the `LC` object,
per `uploads/BRAND-VOICE.md`) → ported faithfully to `app/lib/marketing/content.ts`, voice
untouched. Note `shared/site-common.jsx` still exists upstream and is still loaded by the
Master, but only for its **helpers** (`useSolidNav`, `csInjectStyle`, `FinePrint`) — its copy
constants (`CS_HOW_STEPS`, `CS_FAQ`, `CS_MATRIX`, `CS_FOOTER`) are **dead**, superseded by
`LC`. Don't port from it.

### 2026-07-18 re-pull — what changed

The upstream Master was **recomposed and recopied wholesale**; this was a Layer C rewrite,
not a tweak. Tokens (Layer A) were byte-identical, so nothing in `app/styles/ds/` moved.

- **New positioning** — "Private. Cost-effective. Simple." replaces "Point it at your photos
  and walk away." The register is shorter and plainer throughout.
- **Pricing model changed** (a real commercial change, confirmed intended): the 3×4 term
  matrix (500 GB/1 TB/2 TB × 1–5 yr rate-lock) is **gone**, replaced by six flat yearly
  sizes — **25 GB free, no card** → 10 TB — plus separately-tabbed retrieval pricing
  ($0.09/GB, $0.50 flat fee, first 1 GB each month free). `CS_MATRIX`, `TERMS`,
  `RATE_LOCK`, `TAPER_NOTE` and the `PricingTable` DS component are all retired.
- **Privacy claim changed** — the ledger now states the key **never leaves the user's Mac**.
  The old `PrivacyPrecise` section disclosed **key escrow** ("today we hold your key").
  ⚠️ The site is now ahead of the daemon here; see Open decisions.
- **Sections retired** (files deleted): `hero-app-mock`, `how-list`, `privacy-precise`,
  `pricing-stretch`, `faq-full`, `closing-somewhere-else`, plus the DS `PricingTable`,
  `KeyValueRow` and `Card` that only they consumed.
- **`/pricing` follows automatically** — it renders the same `SectionPricingTabbed`, so the
  standalone Paddle-review URL can't drift from the home page's numbers.

## Checkout

- The public **checkout _page_** (currently `account-backend/src/routes/checkout.ts` — a
  brandless HTML page that loads Paddle.js and auto-opens the overlay on `?_ptxn=`) re-homes
  here as a branded RR7 `/checkout` route.
- The authenticated **`checkout-session` API stays in `account-backend`** (needs Cognito auth,
  Paddle secret, the webhook/entitlement flow). Not a page — do not move.
- Site env: `PUBLIC_PADDLE_CLIENT_TOKEN` + `PUBLIC_PADDLE_ENVIRONMENT` (public client tokens,
  TF-managed per-stack).
- **Ben's action (Phase 3):** repoint Paddle's dashboard default-payment-link from
  `api.coldstorage.sh/checkout` → `coldstorage.sh/checkout` (+ staging).

## Phases (hardest / riskiest first)

- **Phase 1 — prove the spine. ✅ DONE.** Scaffolded `site/` (RR7 v7 for Vercel, light-only
  theming, i18n, generouted); DS tokens pulled verbatim → `app/styles/ds/` + shadcn alias;
  `HowList` ported end-to-end (SSR-safe motion, typed content, real CSS); typecheck + build green.
- **Phase 2 — breadth. ✅ DONE.** All 6 sections + `MarketingNav`/`Footer` + DS component library
  (Button/Badge/Card/CtaPanel/PricingTable/Accordion/KeyValueRow) + the Mac vault mock; full Master
  composition at `/` + `/fr`; typecheck + build green, section copy server-rendered.
  _Open: pixel fidelity of the bundle-only reconstructions (nav logo glyph, "Most picked" pricing
  badge, nav/footer/PricingTable/CtaPanel look) — awaiting Ben's visual pass._
- **Phase 3 — checkout. ✅ DONE (code).** Branded `/checkout` route (Paddle.js overlay opener,
  optional-token graceful state), `PUBLIC_PADDLE_CLIENT_TOKEN` + `PUBLIC_PADDLE_ENVIRONMENT` env,
  and the `window.env` client-env injection (a foundation piece — wired in `root.tsx`). typecheck +
  build green. _Ben's action:_ repoint Paddle's default-payment-link → `coldstorage.sh/checkout`
  (+ staging). _After repoint:_ the account-backend `src/routes/checkout.ts` HTML page is redundant
  and can be removed (leave it until the link is moved — it's still the live target).
- **Phase 4 — infra / deploy. ✅ APPLIED + LIVE.** `infra/site/` (Terragrunt root + modules/{shared,stack}
  + live/{shared,production,staging}), `tf:site:*` tasks + pickers, `fmt` clean — applied to real
  AWS/Vercel. Dormant OIDC role + the two `PUBLIC_PADDLE_*` env vars (no Cognito/DB/secrets). DNS for
  `coldstorage.sh` is Vercel-managed (not TF/Route53). Vercel project `prj_QkTYTMBTzLCHXCsRncrrAThMSlv7`,
  slug **`coldstorage-web`** (`project_name`/state label is `coldstorage-site`). Site deployed + serving.

### Still pending (2026-07-05)
  - **OIDC-trust re-apply** — `vercel_project_name` corrected `coldstorage-site` → `coldstorage-web`
    (uncommitted in `infra/site/live/*/terragrunt.hcl`); `task tf:site:apply ENV=production` + `ENV=staging`
    to land it. Dormant (site makes no AWS calls) → low-urgency.
  - **Live Paddle token** — prod checkout needs it; `TODO_PASTE_LIVE_PADDLE_CLIENT_TOKEN_HERE` placeholder
    in `infra/site/live/production/terragrunt.hcl` (staging already has the real sandbox token).
  - **Paddle default-payment-link** → `coldstorage.sh/checkout`: **repointed by Ben.** After it, the old
    `account-backend/src/routes/checkout.ts` HTML page is redundant → remove.
  - **Brand polish** — the reconstructed nav logo (snowflake `ac_unit`) + "Most picked" pricing badge
    (Ben okayed "for now"). Real treatment TBD.

## Routes · navigation

Every primary-nav destination is a **real page**, not an in-page anchor — so there is one
`NAV_LINKS` list rather than a home/away pair to keep in sync, and `MarketingPage`
(`components/marketing/marketing-page.tsx`) wears the chrome for all of them.

| Route | What | Sections |
| --- | --- | --- |
| `/` | the Master composition | all six |
| `/how-it-works` | **new 2026-07-18** — the deep-storage explainer | `HowExplainer` ×3 + closing |
| `/pricing` | canonical pricing URL (Paddle domain review) | `PricingTabbed` + closing |
| `/faq` | **new 2026-07-18** — questions on a stable URL, + `FAQPage` JSON-LD | `FaqSplit` + closing |
| `/download` | the download page (see Open decisions → download behaviour) | CtaPanel |
| `/about` | **new 2026-07-18** — why it exists, who's behind it, how it makes money | `ProsePage` |
| `/source` | **new 2026-07-18** — the repo, the license, and where the crypto lives | `ProsePage` |
| `/help` | **new 2026-07-18** — the help center: longer answers than `/faq` | `HelpCenter` ×3 |
| `/contact` | **new 2026-07-18** — the contact form (the app's only `action`) | `SectionContact` |
| `/privacy` · `/terms` · `/refunds` | legal prose | `LegalPage` |

- **The wordmark links home** (`/`). It previously scrolled to top, which did nothing on any
  page that wasn't the home page.
- **"Privacy" is not in the nav** — there is no privacy *marketing* page, only the `/privacy`
  legal policy, which lives in the footer's legal row. The home page keeps its privacy
  *section*; it just isn't a nav destination.
- **`/how-it-works` copy** lives in `HOW_PAGE` in `content.ts`, like all other copy. Two
  constraints govern the page and are asserted against the rendered HTML: **the backend
  provider is never named**, and **no dollar figures** (the numbers live on `/pricing`).
- **The footer's dead links are gone (2026-07-18).** Its Company and Support columns pointed at
  four labels with no `href` behind them; all four are now real routes. **"Transparency notes"
  and "Status" were cut** rather than built (Ben) — a Status link that isn't a status page is
  worse than no link.
- **Three routes share one renderer.** `/how-it-works`, `/about`, and `/source` are the
  same layout with different words, so `how-explainer.tsx` became
  `sections/prose-page.tsx`, driven by the `ProsePageContent` shape in `content.ts` (PILLAR3).
  A fourth prose page is a content object plus a four-line route; the CTA target is a prop, so
  `/source` sends people to GitHub instead of to a download.
- **`/help` reuses the DS `Accordion`** — that's why `HelpItem` is a type alias of `FaqItem`.
  One disclosure implementation, one set of a11y behaviours, and every answer stays in the DOM
  for no-JS and for crawlers. It deliberately carries **no `FAQPage` JSON-LD**: `/faq` already
  has it, and two competing FAQPage blocks on one domain is worse than one clear one.

### `/contact` — the first `action` in the app

The site was loader-only until 2026-07-18. `/contact` adds the one write path:

```
form → Turnstile siteverify → zod (contact.ts) → CD2 (@cdv2/email) → ben@m.coldstorage.sh
```

| Piece | Where | Note |
| --- | --- | --- |
| Shared contract | `lib/marketing/contact.ts` | field names + zod schema + the typed `ContactResult`. **Not** a `.server` module — the form imports the same schema, so browser and action can't disagree. |
| Server half | `lib/marketing/contact.server.ts` | Turnstile verify + the CD2 send. `from` is the published support address, **`replyTo` is the sender** — hitting reply in the inbox writes back to the person. |
| Form | `components/marketing/sections/contact-form.tsx` | `useFetcher` (no navigation). Turnstile is rendered **explicitly**, because tokens are single-use and a rejected submit has to `reset()` the widget. |
| Env | `lib/env/contact-env.server.ts` | `CD2_API_KEY`, `TURNSTILE_SECRET_KEY`, `PUBLIC_TURNSTILE_SITE_KEY` — all **optional at boot**, following the `paddle-env` precedent so the site still starts unconfigured. |

**Unconfigured behaviour is loud, not silent.** No CD2 key ⇒ the action returns `failed`, the
form says so and offers the direct address, and the server logs it. No Turnstile secret ⇒ the
message still sends and the server warns that it accepted it **without a spam check** — a spam
check that quietly isn't running is the failure mode you discover via the inbox.

Vercel env vars are TF-managed in `infra/site/`: the site key rides in `tf_managed` (it's
public), the two secrets are declared as `manual_secrets` and valued in the dashboard. Staging
uses Cloudflare's always-passes **testing** pair so the real widget and the real siteverify
round trip are exercised there.

### Verifying — `task ssr:check:site`

`typecheck` proves the types line up and `build` proves the bundle links; neither renders a
page. `scripts/ssr-check.ts` calls the production request handler directly (no port, no dev
server) to render all 11 routes, assert each came out with expected content, assert the
rendered-HTML rules (**no provider named**, **no dollar figures on `/how-it-works`**), and
exercise the `/contact` action end-to-end. With no `CD2_API_KEY` present it pins the `failed`
branch, which proves the whole chain is wired without sending mail; with a key set that last
case is **skipped**, not neutered.

## Open decisions · flags

- **`/how-it-works` has no durability story** — _GAP, needs writing._ A block claiming the
  encrypted files are "copied across several separate locations… and checked over time" shipped
  briefly and was **pulled 2026-07-18 as a false claim** (Ben). Readers reasonably want to know
  their files won't rot, so this is worth answering — but only from verified infrastructure
  behaviour, not from intuition about how the storage tier probably works.
- **`/how-it-works` retrieval detail is deliberately qualitative** — no numbers on that page;
  `/pricing` carries them.
- **`/how-it-works` + `/faq` have no upstream design** — both are stack-assembled from existing
  DS primitives and the shared `csf-*` layout classes (same status as `/download`). The copy is
  written and voiced; the *layout* is ours. Flag all three for an upstream design pass whenever
  the next design session runs. **`/about`, `/source`, `/help`, `/contact` (2026-07-18)
  are in the same boat** — same assembly, same flag.

- **Two lines on the new pages need Ben's confirmation before they ship** — _OPEN, 2026-07-18._
  Both are flagged in `content.ts` where they live, and both assert facts only he can verify:
  `ABOUT_PAGE` says ColdStorage is **"made by one person, in Burlington, Ontario, Canada"**
  (the city matches `legal.ts`'s registered address; the headcount is inferred), and
  `CONTACT_PAGE.responseNote` promises a reply **"within a couple of business days"** — only
  ship a window that's actually going to be met.
- **The repo is source-available under FSL-1.1-ALv2** — _SETTLED, 2026-07-18._ Root `LICENSE`
  added (there was none). Ben's framing: he wants the code **visible and checkable**, not open
  source, and isn't taking contributions for the foreseeable future. Apache-2.0 was drafted
  first and rejected for exactly that reason — it licensed `account-backend/` for anyone to run
  as a competing service, and bought an "open source" badge he doesn't need.
  [FSL](https://fsl.software/) is BUSL with the fill-in-the-blanks removed (BUSL's variable
  Additional Use Grant makes every implementation a bespoke license — part of why the Terraform
  relicense went so badly). Each version auto-converts to Apache-2.0 after two years.
  **The standing rule this creates:** `/source` must never call it open source, and
  `copy-check.ts` enforces that in two directions — no "open source" in any heading/label, and
  the explicit "we're not going to call this open source" line has to still be there. Claiming
  an OSI license we don't have would poison the exact thing publishing the code buys.
- **The DS has no input primitive** — the contact form's `Field` (input/textarea/label/error)
  is local to `contact-form.tsx` on purpose rather than posing as a DS component. If a second
  form ever appears, promote it upstream instead of copying it.
- **Turnstile's production widget doesn't exist yet** — `infra/site/live/production` carries a
  self-naming placeholder site key. Until a real widget is created for `coldstorage.sh`,
  production's `/contact` sends **without a spam check** (logged). Staging already uses
  Cloudflare's always-passes testing pair.
- **CD2 delivery is not confirmed, only accepted** — `sendContactMessage` returns once CD2 has
  queued the message; SES reports final state asynchronously. For a contact form that's the
  right place to stop, but it means a bounce shows up as silence rather than as an error. If
  that ever bites, poll `client.get(id)`.

- **Hero + drag-in media are placeholders** — _OPEN, 2026-07-18._ Upstream ships both media
  areas as empty `<image-slot>` drop zones ("Drop hero demo — app screenshot or video still");
  design never filled them. Ben's call: ship **styled placeholder frames**
  (`components/marketing/shared/media-frame.tsx`) at the exact aspect ratios the design
  specifies, so composition and responsive behaviour are real. **This is the top thing the
  page is waiting on** — swapping in the finished asset is a one-line change per slot
  (`<MediaFrame>` → `<img>`/`<video>`).
- **`vault-mock.tsx` + `mac-window.tsx` are now orphaned** — the animated Mac vault window
  lost its only consumer when `hero-app-mock` was retired. **Deliberately kept, not deleted:**
  it is the obvious candidate to fill the hero media slot above, it's a non-trivial SSR-safe
  port, and its upstream source (`shared/vault-mock.jsx`) still exists. Either promote it into
  the hero or delete it once real media lands — don't leave it drifting indefinitely.
- **Privacy copy is ahead of the product** — _NEEDS A DECISION._ The new privacy ledger says
  "We never get that key, and there's no copy on our side." The previous copy deliberately
  disclosed key escrow, and `PROD.md` still describes escrow as the live design. Either the
  daemon moves to device-only keys before this page can stand behind the claim, or the copy
  gets walked back upstream. **Do not resolve this in the repo — it's a product+legal call.**
- **Pricing CTAs point at `/download`** — upstream leaves every pricing button as `href="#"`.
  There is no web plan-picker: selection happens in-app (sign in → pick size → Paddle), and
  `/checkout` only opens an overlay for a transaction Paddle already created, so it can't take
  a cold visitor. `/download` is the honest target until a web picker exists.
- **New numbers vs Paddle** — the six tier prices and the retrieval rates are now published on
  a live site. They need reconciling against the actual Paddle catalogue before the paid flow
  opens (`PROD.md` Phase 4/6).
- **Site prices are hand-mirrored from the code SSOT** — _CLOSED 2026-07-18 by a guard._
  `PRICING.tiers` in `content.ts` mirrors `account-backend/src/plan-sizes.ts` (generator-derived,
  `round(1.8 * bytes/1e9 + 99)` cents). The packages are independent with **no root workspace**,
  so the site can't import the list at build time — but `task copy:check:site` imports both and
  asserts they agree (yearly *and* the derived monthly), so drift fails loudly instead of
  shipping. A shared package or root workspace would be the purer fix; it would couple two
  deploy targets to buy what the guard already buys.

- **`MarketingNav` / `MarketingFooter` / `CtaPanel` / `PricingTable`** — _RESOLVED 2026-07-05:_
  no source in either project (`components/core/` holds only generic primitives); they exist
  **only compiled in `_ds_bundle.js`**. Decision: **reimplement as fresh stack components** styled
  with DS tokens (their data already lives in `site-common.jsx` — nav links, `CS_FOOTER`), extracting
  exact look from the bundle. Cleaner than reverse-engineering minified JS, and they're the
  "marketing-specific components" the site is meant to own anyway.
- **"Download for Mac" CTA target** — _RESOLVED 2026-07-05, page added 2026-07-10:_ all three CTAs
  (nav + hero + closing) link to a single `DOWNLOAD_PATH` (`app/lib/marketing/download.ts`) → now the
  standalone **`/download` page** (`($lang).download.tsx` — CtaPanel-based: install steps, a manual
  "Download for Mac" button + an "All releases" fallback). _Settled 2026-07-18:_ **the button's label
  decides whether arriving starts the file.** A CTA that says "Download…" sends you to
  `DOWNLOAD_START_PATH` (`/download?start=1`), where a `<meta http-equiv="refresh">` starts the .dmg
  and the page reads "Your download should start shortly"; a CTA that doesn't say download (the
  pricing table's "Get started"/"Choose") sends you to `DOWNLOAD_PATH` (`/download`), which starts
  nothing and invites the click. The manual button is on both — fallback for a blocked auto-start,
  and the only control on the no-param path. The param is resolved in the **loader**, so `meta()` and
  the component share one decision and the auto-start survives no-JS. The actual file fetch is
  `DOWNLOAD_DMG_PATH` → the **`/download.dmg` resource route** (`download[.]dmg.tsx`, the former
  `/download` 302), which resolves the *latest* GitHub Releases build and 302s to its `.dmg`
  (edge-cached hourly; falls back to the releases page on failure). No version is hardcoded, so
  release bumps need no site edit. Current build is **arm64-only** (v0.1.0) — the clean cross-arch
  fix is a **universal `.dmg`** (build-side, `ui/electron-builder.yml`), _not_ an arch-picker
  downloads page; deferred until Intel matters (all new Macs are Apple Silicon; macOS 27 drops
  Intel). The resource route already supports a multi-platform future without touching the buttons.
  The page is stack-assembled from existing DS pieces (CtaPanel/Button/Nav/Footer) — flag it for an
  upstream design pass whenever the next design session runs.
- **Fonts loading strategy** — Phase 2 (see Upstream projects → Fonts).

## Non-goals (for now)

- **Not** unifying the Electron app's tokens with the DS — separate lineage; out of scope.
- **No** dark mode (DS has none).
- **No** codegen-translation of design JSX (brittle; fails PILLAR2 — translation is an agent).
- **No** moving the `checkout-session` API or any webhook/entitlement logic out of `account-backend`.
