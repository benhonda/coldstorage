# ColdStorage Marketing Site — Build & Sync Spec

> **Status:** provisional · Phase 1 in progress · last touched 2026-07-05
> This spec is a living document, not scripture. If the code and this file disagree,
> the code wins — fix the file. Re-read the **Drift check** before executing any phase.

## Goal

Stand up the ColdStorage **marketing site** (`coldstorage.sh`) as an RR7/adpharm-stack app
that renders with the ColdStorage **Design System**, carries marketing sections **designed
upstream** in Claude cloud design, and **hosts the checkout page** — with a sync mechanism
that keeps upstream design and repo code aligned **without hand-maintained duplication**
(PILLAR3).

## Where it lives · stack

- **Location:** `site/` (monorepo subdir — `ui/` and `account-backend/` already exist). The
  root `Taskfile.yml` stays the one command surface; `site` gets dir-scoped tasks
  (`start:site` / `link:site` / `pull:site` + a custom `site:design:pull`), and the bare
  `start`/`link`/`pull` become app pickers over `ui` / `backend` / `site`.
- **Stack:** RR7 (SSR) on Vercel, `~/*`→`app/*`, Tailwind v4, zod fail-fast env, its **own
  Vercel project** + **`infra/site/`** Terraform (prod + staging), package/state name
  `coldstorage-site` (from devcontainer `name: coldstorage`).
- **Theming:** **light-only** — the DS defines no dark tokens, and code must not invent them
  (that would recreate the drift we're killing). Keep the no-flash engine, pin to light;
  revisit only if the DS defines dark upstream.
- **i18n:** en/fr on from the start (`/fr` convention); the upstream copy module is the source.

## The three layers · one owner each (this is what kills drift)

| Layer | What | Single source of truth | Sync direction |
| --- | --- | --- | --- |
| **A. Tokens** | color / type / spacing / effects / radius / shadows | **pinned snapshot `_ds/…41ebafc1`** (verbatim, pull-managed → `app/styles/ds/`); `739a…` = origin to reconcile | code pulls down; a thin shadcn-alias layer maps DS vars → shadcn names |
| **B. DS components** | Button, Card, Input, Nav, Footer… | **DS project `739a…`** component source | pulled down; not shared with Electron (coherence = shared tokens, not shared code) |
| **C. Marketing sections** | hero, how, privacy, pricing, faq, closing | **marketing project `942990bc…`** (design) → repo `.tsx` (impl) | pull-only → mirror → agent-translate |

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

`MarketingNav` → `HeroAppMock` → `HowList` → `PrivacyPrecise` → `PricingStretch` →
`FaqFull` → `ClosingSomewhereElse` → `MarketingFooter`.

Copy + the pricing matrix are **already written and voiced** upstream (`shared/site-common.jsx`,
per `uploads/BRAND-VOICE.md`) — ported faithfully, voice untouched.

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
- **Phase 4 — infra / deploy.** `infra/site/` prod + staging, domain, TF-managed env (incl. the
  Paddle vars). **External-facing — I'll prep the Terraform but not create the Vercel project, wire
  the domain, or provision without a heads-up to Ben.**

## Open decisions · flags

- **`MarketingNav` / `MarketingFooter` / `CtaPanel` / `PricingTable`** — _RESOLVED 2026-07-05:_
  no source in either project (`components/core/` holds only generic primitives); they exist
  **only compiled in `_ds_bundle.js`**. Decision: **reimplement as fresh stack components** styled
  with DS tokens (their data already lives in `site-common.jsx` — nav links, `CS_FOOTER`), extracting
  exact look from the bundle. Cleaner than reverse-engineering minified JS, and they're the
  "marketing-specific components" the site is meant to own anyway.
- **"Download for Mac" CTA target** — placeholder (existing release feed) until Ben confirms the
  canonical URL.
- **Fonts loading strategy** — Phase 2 (see Upstream projects → Fonts).

## Non-goals (for now)

- **Not** unifying the Electron app's tokens with the DS — separate lineage; out of scope.
- **No** dark mode (DS has none).
- **No** codegen-translation of design JSX (brittle; fails PILLAR2 — translation is an agent).
- **No** moving the `checkout-session` API or any webhook/entitlement logic out of `account-backend`.
