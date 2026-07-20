# Product Marketing Context — pointer

**The canon lives at [`strategy/CANON.md`](../strategy/CANON.md).** It is the single source of
truth for what ColdStorage is, who it's for, how it sounds, and what it costs us — product,
positioning, audience, voice, copy rules, pricing, unit economics, objections, trust policy.

**Why it's not here:** the canon carries COGS, per-tier margins, and the retrieval quote formula.
This repo is public (see `CLAUDE.md`); `strategy/` is gitignored precisely so the commercial
thinking stays private. A public positioning-only twin was rejected — two docs to keep in sync is
the problem we just solved, and the positioning is hard to state honestly without the economics
that justify it.

**If you're an agent looking for product, audience, or positioning context:** read
`strategy/CANON.md`. If it isn't on disk you're in a clone without the private directory — ask
before drafting marketing copy; don't infer positioning from the live site and proceed.

**What CANON.md does NOT own** (it defers to these, and says so):

| What | Owner |
|---|---|
| Shipped marketing words | `site/app/lib/marketing/content.ts` |
| Prices, as executable truth | `account-backend/src/plan-sizes.ts`, `retrieval-pricing.ts` |
| Legal prose | `site/app/lib/marketing/legal.ts` |
| Engine architecture | `coldstorage/DESIGN.md` |
| Retrieval engineering spec | `RETRIEVAL.md` |
| Going-to-prod plan & status | `PROD.md` |
| Build history | `CHANGELOG.md` |
| Site build architecture | `site/SPEC.md` |
| Prose register / how to write | the `ben-prose` skill |

Run `/product-marketing` to update the canon.
