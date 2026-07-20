/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE MARKETING COPY SSOT. This file is the source, not a copy of one.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every word the marketing site renders lives here. Edit the copy HERE — there is no
 * upstream doc to change first, and nothing regenerates this file.
 *
 * How we got here (2026-07-18, Ben): copy used to be drafted in `strategy/*-copy.md`, which
 * is gitignored and private. That put the words in five places at once (strategy doc → design
 * project upload → design `LC` object → design-mirror → here) with nothing declaring a winner,
 * and the words drifted. `strategy/` is now for high-level thinking and what's next — it does
 * not prescribe artifacts. Shipped copy is public words in version control, reviewed in diffs.
 *
 * WHAT IS *NOT* A COPY SOURCE — do not port words from these, they will be stale:
 *  - `Claude design · shared/landing-copy.jsx` (the `LC` object) and the design
 *    project it mirrors. That is a **preview fixture** so the upstream design renders. It is
 *    mirrored verbatim for clean design diffs, NOT consulted for wording.
 *  - `Claude design · shared/site-common.jsx` — its `CS_*` copy constants are DEAD
 *    (superseded upstream). It is mirrored only for its helper functions.
 *
 * WHAT STILL OWNS SOMETHING ELSE:
 *  - **Framing** (what a page argues) → `strategy/CANON.md` §1/§4.
 *  - **Voice** (how it sounds) → `strategy/CANON.md` §5/§6 + the `ben-prose` skill.
 *  - **Prices** → `account-backend/src/plan-sizes.ts` (generator: `$0.018/GB/yr + $0.99`) and
 *    `account-backend/src/retrieval-pricing.ts` (`quoteCents()`). The numbers in `PRICING`
 *    below mirror those. `task copy:check:site` re-derives them from the code every run, so a
 *    price that moves in one place and not the other fails loudly instead of shipping.
 *  - **Published prices are the REAL prices — never tidied.** Retrieval runs at 0% margin, so
 *    rounding a rate down subsidizes it out of storage margin and rounding it up takes margin
 *    we said we don't take. $0.0974 is not $0.10; $0.53 is not $0.50.
 *  - **Legal prose** → `~/lib/marketing/legal.ts` (its own SSOT; different review path).
 *
 * STANDING CONSTRAINTS on everything in this file:
 *  - **Never name the backend provider in customer copy** — no "AWS", "S3", "Glacier", no
 *    vendor, anywhere. (Firm reversal, Ben 2026-07-17; the earlier "name AWS in one FAQ slot"
 *    rule is dead.) Legal disclosure in `legal.ts` is the one carve-out — it must name them.
 *  - **No fear-mongering, no "safe"/"secure" claims.** Calm and factual; status is
 *    information, not comfort.
 *  - **Never over-claim past the architecture.** True zero-knowledge shipped (PROD.md
 *    2026-07-02), so "only you hold the key" is now earned — but claims track the code.
 *  - **Terminology: say "encrypted", never "scrambled".** (Voice delta, 2026-07-17 — reverses
 *    the older "scrambled on your Mac" phrasing, which the design's `LC` still uses.)
 *  - **In copy the product is `ColdStorage`, capitalised — always.** The lowercase
 *    `coldstorage` is the WORDMARK only: a drawn brand artifact, rendered exclusively by the
 *    `<Wordmark>` component, never typed as a string. Nothing in this file should ever say
 *    "coldstorage" (Ben, 2026-07-20; `task ssr:check:site` asserts the rendered logotype).
 *  - **Never frame our own costs as "nearly free"/"basically nothing".** It reads as "then why
 *    am I paying you", and it isn't true — storage carries real cost plus a modest margin;
 *    only retrieval runs at zero markup. Explain cheapness comparatively.
 *
 * i18n: English-only today; the `/fr` pass will pair each string with its translation
 * (see site/SPEC.md → i18n).
 */

// The two published contact addresses belong to `legal.ts` (they're the controller/seller
// contacts of record). Imported rather than retyped so the marketing pages and the legal
// pages can never disagree about where to write.
import { LEGAL_EMAIL, SUPPORT_EMAIL } from "~/lib/marketing/legal";
import type { BrandColorKey } from "~/lib/brand/brand-palette";

/* ──────────────────────────────  Page heads  ─────────────────────────────── */

/**
 * The head of any page that isn't the landing page — eyebrow, `<h1>`, and the paragraph that
 * frames what follows. Every such page renders it through the one `<PageHero>` component
 * (upstream `page-heroes.jsx`, variant B), so this is the shape that component consumes.
 *
 * Declared once and extended by the page shapes below rather than retyped per page: three of
 * them already had exactly these three fields, and letting them drift apart is how you end up
 * with three page headers that are almost the same.
 */
export type PageHeadContent = {
  eyebrow: string;
  title: string;
  intro: string;
};

/* ────────────────────────────────  Hero  ─────────────────────────────────── */

export type Hero = {
  /** The headline, split so one word can carry the accent colour. */
  headline: { before: string; accent: string; after: string };
  lead: string;
  cta: string;
  note: string;
};

export const HERO: Hero = {
  // Ben, 2026-07-20. The ICP angle from strategy/CANON.md §2 — "the stuff they'd hate to
  // lose but open maybe once a year". A rotating noun was tried and cut the same day: one word,
  // accented.
  headline: {
    before: "For the",
    accent: "memories",
    after: "you can't afford to lose",
  },
  // Carries a live price, so it is guarded: `task copy:check:site` re-derives both the figure and
  // the size from `PLAN_SIZES` (the entry plan) every run. Same treatment as `PRICING.tiers` —
  // a price written in copy that nothing checks is a price that goes stale silently.
  lead: "Encrypted cloud backups for your files starting at $9.99 per year for 500 GB",
  cta: "Download for Mac",
  note: "Free to start: 25 GB, no card.",
};

/* ─────────────────────────────  How it works  ───────────────────────────── */

export type How = { eyebrow: string; title: string; body: string };

export const HOW: How = {
  eyebrow: "How it works",
  title: "Drag in what you want to keep",
  body: "Open the app, drag in the photos or files you want to keep, and they upload. Pull in your whole camera roll or a single folder — whatever you drop in gets encrypted on your Mac and stored. There's no setup, and nothing to manage after.",
};

/* ─────────────────────  How it works (the /how-it-works page)  ───────────── */

/*
 * The deep-storage explainer (`/how-it-works`), linked from the pricing section's callout.
 * First draft, agreed "good for now" — not settled.
 *
 * Page-specific constraints, on top of the file-header ones:
 *  - **No dollar figures on this page.** The retrieval cost stays qualitative here; the actual
 *    numbers live on /pricing. (Both this and the never-name-the-provider rule are asserted
 *    against the rendered HTML — see site/SPEC.md.)
 *
 * ⚠️ GAP — this page has no durability story. One shipped briefly and was pulled 2026-07-18 as
 * a false claim (see the note where the block used to be). Readers reasonably want to know
 * their files won't rot; that answer needs writing from verified infrastructure behaviour.
 */

export type ProseBlock = {
  heading: string;
  /** One entry per paragraph, in order. */
  body: string[];
};

/**
 * A headed prose page: eyebrow, title, a framing paragraph, headed blocks, and a closing CTA.
 * Three routes share this shape and the one `<ProsePage>` renderer — `/how-it-works`,
 * `/about`, `/open-source`. Adding a fourth is a content object plus a four-line route.
 */
export type ProsePageContent = PageHeadContent & {
  blocks: ProseBlock[];
  cta: { label: string; note: string };
};

export const HOW_PAGE: ProsePageContent = {
  eyebrow: "How it works",
  title: "How deep storage works",
  intro:
    "ColdStorage is deep storage — the kind built for files you want to keep but hardly ever open. That's the whole reason it's cheap, and it's also why getting a lot back takes a little patience. Here's how it actually works, and why it costs what it does.",
  blocks: [
    {
      heading: "Why it costs so little",
      body: [
        "Most cloud storage keeps every one of your files live, ready to open the second you want it. Keeping files awake like that takes real hardware running around the clock, and you pay for it whether you open a file every day or once a decade.",
        "Deep storage does the opposite. Your files rest on low-power storage that isn't kept spinning and waiting, so it costs far less to run than keeping everything live and ready. That's where the low price comes from — you're not paying to keep your files awake when they don't need to be.",
      ],
    },
    {
      heading: "What happens when you put files in",
      body: [
        "When you drag files into the app, they're encrypted right there on your Mac, before anything leaves your computer. The encrypted copies are what upload and settle into deep storage. The key that unlocks them stays on your device — we never receive it, so what we're holding is a pile of files we can't read.",
      ],
    },
    {
      heading: "What happens when you get them back",
      body: [
        // "or sooner if you pay a bit to hurry it" removed — V1 sells the bulk tier only, so
        // there is no faster option to offer. ~48 hours is what `TYPICAL_WAIT` actually promises.
        "Because your files are resting instead of sitting live, they can't be handed over on the spot. When you ask for something, it's brought up out of deep storage and made ready — usually in about two days.",
        "Pulling files back has a cost, and we'd rather be plain about it. Part of it is bringing the data up; the bigger part is moving it across the internet to you, which is a real expense on our end. We charge you exactly what those cost us and nothing more — you see the amount before anything runs, and a little each month is free.",
        "We make our money on storage, not on handing your files back, so there's no reason for us to make that cost a penny more than it is.",
      ],
    },
    /*
     * REMOVED 2026-07-18 — a "How your files are kept" durability block claimed the encrypted
     * files are "copied across several separate locations, so losing one machine — or a whole
     * building — doesn't lose them" and are "checked over time to make sure they're still
     * whole". Ben: that is a false claim. It shipped unverified and is now pulled.
     *
     * A durability story is a fair thing for a reader to want, so this is a gap worth filling —
     * but only with a claim someone has checked against what the infrastructure actually does
     * and guarantees. Do not restore the old wording, and do not write a replacement from
     * intuition about how the storage tier "probably" works.
     */
  ],
  cta: { label: "Download for Mac", note: "Start with 25 GB free." },
};

/* ───────────────────────────────  Privacy  ──────────────────────────────── */

export type PrivacyStep = {
  /** Material Symbols Rounded glyph name — also the React key upstream uses. */
  icon: string;
  title: string;
  body: string;
};

export type Privacy = {
  eyebrow: string;
  title: string;
  lead: string;
  steps: PrivacyStep[];
};

export const PRIVACY: Privacy = {
  eyebrow: "Privacy",
  title: "Only you can open them",
  lead: "Your files are encrypted on your Mac before they leave it, with a key only you hold. We never get that key, so we can't open your files. Only you can.",
  steps: [
    {
      icon: "enhanced_encryption",
      title: "Encrypted on your Mac",
      // "encrypted", never "scrambled" — see the header's terminology rule.
      body: "Files are encrypted before they leave your machine.",
    },
    {
      icon: "key",
      title: "The key stays with you",
      body: "We never get it, and there's no copy on our side.",
    },
    {
      icon: "visibility_off",
      title: "We store what we can't read",
      body: "What sits with us is data only you can open.",
    },
  ],
};

/* ───────────────────────────────  Pricing  ──────────────────────────────── */

export type PricingTier = {
  size: string;
  /** Yearly price, or "Free" on the free tier. */
  year: string;
  /** Monthly equivalent, or an em-dash on the free tier. */
  month: string;
  free?: boolean;
};

export type RetrievalRow = { label: string; value: string };

export type Pricing = {
  eyebrow: string;
  title: string;
  /** Lead used when the retrieval numbers sit behind a second tab (the shipped Master). */
  lead: string;
  /** Lead used when both halves are visible at once. */
  leadNoTabs: string;
  tiers: PricingTier[];
  moreLead: string;
  moreLink: string;
  renewNote: string;
  retrievalTitle: string;
  retrievalLead: string;
  retrievalRows: RetrievalRow[];
  readyNote: string;
  callout: string;
  calloutLink: string;
  finePrint: string;
  /** Editorial microcopy for the tabbed table — labels a reader actually sees. */
  ui: {
    tabs: { storage: { label: string; sub: string }; retrieval: { label: string; sub: string } };
    columns: { size: string; perYear: string; perMonth: string; /** a11y-only */ cta: string };
    freeBadge: string;
    ctaFree: string;
    ctaPaid: string;
  };
};

/*
 * The tiers below mirror `account-backend/src/plan-sizes.ts` — that file is the price SSOT,
 * and its prices are generator-derived (`round(1.8 * bytes/1e9 + 99)` cents). Do NOT hand-type
 * a new row: derive it there, then mirror it here. `month` is `year / 12`, presentational only.
 *
 * The 25 GB free tier is deliberately NOT a row in `PLAN_SIZES` (it's an entitlement, never a
 * sellable Paddle product), so it exists only here on the marketing side.
 *
 * ⚠️ KEEP HONEST — `readyNote` ("Ready in a day or two…") is the ONLY place the not-instant
 * expectation is set on the landing page; everything else about the wait lives on
 * /how-it-works. Do not cut it. (Standing rule from the copy review, 2026-07-17.)
 */
export const PRICING: Pricing = {
  eyebrow: "Pricing",
  title: "Start with 25 GB free, no card",
  lead: "When you need more room, pick a size. Getting files back has its own simple numbers — they're on the second tab.",
  leadNoTabs:
    "When you need more room, pick a size. Getting files back has its own simple numbers — they're right below.",
  tiers: [
    { size: "25 GB", year: "Free", month: "—", free: true },
    { size: "500 GB", year: "$9.99", month: "$0.83" },
    { size: "1 TB", year: "$18.99", month: "$1.58" },
    { size: "2 TB", year: "$36.99", month: "$3.08" },
    { size: "5 TB", year: "$90.99", month: "$7.58" },
    { size: "10 TB", year: "$180.99", month: "$15.08" },
  ],
  moreLead: "More than 10 TB?",
  moreLink: "Get in touch",
  renewNote: "Plans renew once a year, and we tell you before they do.",
  retrievalTitle: "Getting files back",
  retrievalLead:
    "Storing is your yearly plan. Pulling files back out costs what it costs us to move them — no markup. Here are the numbers, so you can work it out yourself.",
  /*
   * These are the ALL-IN customer prices, derived from `account-backend/src/retrieval-pricing.ts`
   * — `quoteCents()` is the SSOT and `task copy:check:site` re-derives these from it every run.
   *
   * Do not "tidy" them. $0.0974 is not $0.10 and $0.53 is not $0.50: retrieval runs at 0% margin, so
   * a rounded-down rate is a subsidy paid out of storage margin, and a rounded-up one is margin
   * we said we don't take. The published number has to be the real one.
   *   $0.0974/GB = (egress $0.09 + thaw $0.0025) ÷ 0.95 (Paddle's 5%)
   *   $0.53    = Paddle's $0.50 flat ÷ 0.95
   */
  retrievalRows: [
    { label: "First 1 GB each month", value: "Free" },
    { label: "Every GB you pull back", value: "$0.0974" },
    { label: "Flat fee per recovery", value: "$0.53" },
  ],
  // ~48 hours is the BULK tier's wait, and bulk is the only tier V1 sells. The old copy offered
  // "sooner if you pay a bit to hurry it" — we don't sell expedited retrieval, so that was a
  // promise the product can't keep.
  readyNote: "Ready in about 48 hours.",
  callout:
    "Pulling a lot of data back out is a real cost to move, and we pass it through with no markup.",
  calloutLink: "How deep storage works →",
  // Was: "Plus a small bring-up cost and card processing (~5%) … computed exactly, never rounded
  // up." Both halves were false once the rates above became all-in — the bring-up cost and the
  // 5% are now *inside* them, not added on, and a quote does round up to the whole cent.
  finePrint:
    "Those rates already include the bring-up cost and card processing — nothing gets added on top. The exact total is always shown before you confirm. The free monthly amount is 1 GB on paid plans, 200 MB on the free plan.",
  ui: {
    tabs: {
      storage: { label: "Storage", sub: "Yearly plans by size" },
      // Considered alternative for this label: "Retrieval". "Getting files back" won — it says
      // what happens in words a reader already uses.
      retrieval: { label: "Getting files back", sub: "What a recovery costs" },
    },
    columns: { size: "Size", perYear: "Per year", perMonth: "Per month", cta: "Choose a plan" },
    freeBadge: "free · no card",
    ctaFree: "Get started",
    ctaPaid: "Choose",
  },
};

/*
 * The `/pricing` page head. Entirely derived — no new words. It reuses `leadNoTabs` because the
 * standalone page shows the head above the tabs rather than beside them, so the "they're right
 * below" phrasing is the one that's true there.
 */
export const PRICING_PAGE: PageHeadContent = {
  eyebrow: PRICING.eyebrow,
  title: PRICING.title,
  intro: PRICING.leadNoTabs,
};

/* ─────────────────────────────────  FAQ  ────────────────────────────────── */

export type FaqItem = { question: string; answer: string };

export type Faq = { eyebrow: string; title: string; items: FaqItem[] };

/*
 * The answers below are first-draft seeds — the questions were chosen deliberately, the
 * wording is not finalized. Built to be a real, SEO-worthy section (it has its own route at
 * /faq, with FAQPage JSON-LD), so it's worth filling out.
 *
 * BACKLOG — questions agreed as worth answering, not yet written:
 *  - How long does it take to get my files back?
 *  - What can I store? Does it back up my iPhone photos?
 *  - What happens if I stop paying?
 *  - What happens to my files if ColdStorage shuts down?
 *  - Can someone reach my files if something happens to me?
 *  - Is there a Windows app?
 *  - Where are my files actually stored?   ← answer WITHOUT naming the provider (see header)
 */

/* ────────────────────────────  Compare (/compare)  ──────────────────────── */

/**
 * A row of the comparison table. `ours` and `theirs` are prose, not just numbers — the
 * interesting differences here (when you get files back, who holds the key, what leaving
 * costs) don't reduce to a figure, and a table of ticks and crosses would flatten exactly the
 * nuance that makes this page worth citing.
 */
export type ComparisonRow = { label: string; ours: string; theirs: string };

export type ComparisonPage = PageHeadContent & {
  /** Prose above the table — what each tier is for. */
  blocks: ProseBlock[];
  table: { ourHead: string; theirHead: string; rows: ComparisonRow[] };
  /** Rendered under the table. Names the source and the date, because both matter. */
  sourceNote: string;
  /**
   * Prose below the table. Split from `blocks` because order carries the argument here: the
   * "which one you want" honesty only lands once the reader has seen the numbers it's
   * qualifying. Above the table it reads as hedging; below it reads as fair.
   */
  blocksAfterTable: ProseBlock[];
  cta: { label: string; note: string };
};

/*
 * `/compare` — the "is this cheaper than what I already pay for" page.
 *
 * Comparison pages are the single most-cited content format in AI answers, and this is the
 * question a person actually types. It exists to be the page that answers it properly.
 *
 * ── Rules specific to this page, beyond the file-header ones ──────────────────────────────
 *
 * 1. **One named competitor, one verified number.** iCloud+ is priced from Apple's own page
 *    (apple.com/icloud, checked 2026-07-20): 2 TB at $9.99/mo = $119.88/yr. Google One and
 *    Dropbox are referred to generically and WITHOUT figures — their US pricing could not be
 *    confirmed from a primary source (Dropbox's page geo-served CA$; Google One had an
 *    unresolved promo-vs-renewal split). A wrong competitor price on a public comparison page
 *    is a claim someone can challenge, and it would undercut the one thing this brand sells.
 *    **Do not add a figure here from a blog post or from memory — only from the vendor's own
 *    pricing page, and update `COMPARISON_VERIFIED_ON` when you do.**
 *
 * 2. **Be fair, and say plainly when they're the better choice.** The "which one you want"
 *    block tells people with actively-used files to stay where they are. That is not a
 *    concession — a comparison that never concedes anything reads as an ad and gets treated
 *    as one. It's also just true.
 *
 * 3. **The table includes what we're worse at.** Instant access and free egress are real
 *    advantages of a live drive, and they're in the table as such. Omitting them would be the
 *    kind of quiet over-claim the transparency pillar exists to prevent.
 *
 * 4. **Never anti-cloud.** We ARE cloud storage; the axis is live-and-openable vs. resting.
 *    `copy-check.ts` enforces this and will fail the build on "cheaper than the cloud" phrasing.
 */

/** When the competitor pricing below was last checked against the vendor's own page. */
export const COMPARISON_VERIFIED_ON = "2026-07-20";

export const COMPARE_PAGE: ComparisonPage = {
  eyebrow: "Compare",
  title: "ColdStorage and instant-access storage",
  intro:
    "Cloud storage comes in tiers. The familiar ones — iCloud, Google Drive, Dropbox — keep every file live, openable the second you want it. ColdStorage keeps files resting instead, and brings them back when you ask. Same category, different tier. The price follows from which one your files actually need.",
  blocks: [
    {
      heading: "What keeping files live buys you",
      body: [
        "When a file is live, it sits on hardware running around the clock so it's there the instant you tap it. That's genuinely worth having. If you're opening documents on your phone, sharing folders with people, or working out of the same folder every day, that's the tool for the job.",
        "The thing to know is that you pay that rate for every file on the plan — the ones you open daily and the ones you haven't touched since 2019, at exactly the same price.",
      ],
    },
    {
      heading: "What ColdStorage does instead",
      body: [
        "ColdStorage is built for the second pile. Files rest on low-power storage that isn't kept spinning and waiting, which costs far less to run, and that's where the lower price comes from. Ask for something back and it's brought up and made ready, usually in about two days.",
        "Everything is encrypted on your Mac before it leaves your computer, and the key stays on your device — what we're holding is a pile of files we can't open. Browsing what you've stored is instant either way; only getting files back involves the wait.",
      ],
    },
  ],
  table: {
    ourHead: "ColdStorage",
    theirHead: "iCloud+ (2 TB)",
    rows: [
      { label: "2 TB, per year", ours: "$36.99", theirs: "$119.88 ($9.99/mo)" },
      { label: "Opening a file", ours: "Ready in about 48 hours", theirs: "Instantly" },
      { label: "Seeing what's stored", ours: "Instant", theirs: "Instant" },
      {
        label: "Who holds the key",
        ours: "You. Encrypted on your Mac; we can't open your files",
        theirs: "Depends on the provider and your settings",
      },
      {
        label: "Pulling a lot back out",
        ours: "Billed at what it costs us, quoted first. 1 GB a month free",
        theirs: "Included",
      },
      { label: "Free to start", ours: "25 GB, no card", theirs: "5 GB" },
    ],
  },
  sourceNote: `iCloud+ pricing from Apple's own page, checked ${COMPARISON_VERIFIED_ON}. Google Drive and Dropbox aren't listed with figures here because we'd rather quote nothing than quote a price we haven't confirmed ourselves.`,
  blocksAfterTable: [
    {
      heading: "Which one you actually want",
      body: [
        "If you open these files regularly, or you need them on your phone at a moment's notice, an instant-access plan is the right tool and we'd rather you kept it. Paying for live access to files you genuinely use live is not overpaying — it's buying the thing you need.",
        "ColdStorage is for the other pile: the photos you'd hate to lose, the folders you've carried between four laptops, the things you want kept but won't open this year. Plenty of people end up with both — the live drive for what's in flight, ColdStorage for what's finished.",
      ],
    },
  ],
  cta: { label: "Download for Mac", note: "Start with 25 GB free." },
};

export const FAQ: Faq = {
  eyebrow: "Questions",
  title: "Fair to ask",
  items: [
    {
      question: "How is this different from iCloud, Google Drive, or Dropbox?",
      answer:
        "Those keep your files live and instantly openable, and you pay for that every month. ColdStorage is for files you want kept but rarely open, so it costs a lot less — and your files are encrypted with a key only you hold, so we can't read them.",
    },
    {
      question: "Can you see my files?",
      answer:
        "No. They're encrypted on your Mac before they upload, with a key only you hold. We never get the key, so we can't open them.",
    },
    {
      question: "Is there a free plan?",
      answer: "Yes — 25 GB free, forever, no card.",
    },
    {
      question: "What does it cost to get my files back?",
      answer:
        "Each month you can pull back 1 GB for free. Beyond that, you pay only what it costs us to move the data, and you always see the amount before you agree.",
    },
    {
      question: "Can I get all my files back out?",
      answer:
        "Anytime. You can export your whole archive and take it elsewhere — nothing's locked in.",
    },
  ],
};

/*
 * The `/faq` page head. Eyebrow and title are read off `FAQ` rather than retyped, so the page
 * and the landing section can't end up calling the same thing two different names.
 *
 * ⚠️ `intro` is the one genuinely new line here and it is UNCONFIRMED — it was written to fill
 * the page hero's lead slot, which the standalone route previously had nothing in (it opened
 * on an `<h2>` with no `<h1>` above it at all). Ben to confirm or replace.
 */
export const FAQ_PAGE: PageHeadContent = {
  eyebrow: FAQ.eyebrow,
  title: FAQ.title,
  intro:
    "The questions people ask before they trust us with a copy of everything. If yours isn't here, the help center goes into more detail — and you can always just write to us.",
};

/* ────────────────────────────────  Close  ───────────────────────────────── */

export type Close = { eyebrow: string; title: string; lead: string; cta: string };

export const CLOSE: Close = {
  eyebrow: "ColdStorage for Mac",
  title: "Try it with 25 GB free",
  lead: "No card, and nothing to cancel if it's not for you.",
  cta: "Download for Mac",
};

/* ─────────────────────────────────  Nav  ────────────────────────────────── */

export type NavLink = { label: string; href: string };

/*
 * One nav list for every page — each entry is a real route, so there's no longer a
 * home-page ("#how") vs away-page ("/#how") variant to keep in sync.
 *
 * "Privacy" is deliberately absent: there is no privacy *marketing* page, only the
 * `/privacy` legal policy, which belongs in the footer's legal row rather than the primary
 * nav. The home page still carries a privacy *section* — it just isn't a nav destination.
 */
export const NAV_LINKS: NavLink[] = [
  { label: "How it works", href: "/how-it-works" },
  { label: "Pricing", href: "/pricing" },
  { label: "FAQ", href: "/faq" },
];

/* ──────────────────────────  Company + support pages  ───────────────────── */

/*
 * `/about`, `/open-source`, `/help`, `/contact` — the four pages the footer's Company and
 * Support columns used to point at with dead links.
 *
 * All four obey the file-header constraints (no provider named, no "safe"/"secure" claims,
 * nothing claimed past the architecture) and are scanned by `task copy:check:site`.
 *
 * ⚠️ CONFIRM WITH BEN before these ship — two lines assert facts only he can verify:
 *  1. `ABOUT_PAGE` "made by one person, in Burlington, Ontario" — headcount. The address
 *     matches `legal.ts`'s registered address; the headcount is inferred, not confirmed.
 *  2. `CONTACT_PAGE.responseNote` "within a couple of business days" — a response-time
 *     commitment. Only ship a window that's actually going to be met.
 *
 * Product facts below are drawn from shipped behavior, not invented: the passwordless
 * email-code sign-in and the one-time recovery code as the sole human-held secret come from
 * `PROD.md` (Phase 5b, done 2026-07-02); the "drop anywhere to upload", "Request a copy",
 * and browse-is-always-instant behaviors come from `ui/DESIGN.md`. If the app changes, these
 * change with it.
 */

/** Where the code lives — used by the `/source` page and its CTA. */
export const REPO_URL = "https://github.com/benhonda/coldstorage";
/**
 * The license the repo ships under, in prose form. Mirrors the root `LICENSE` file
 * (`FSL-1.1-ALv2` — the Functional Source License with an Apache-2.0 future license).
 *
 * ⚠️ This is SOURCE-AVAILABLE, not open source. The page below must never call it open
 * source, and `copy-check.ts` enforces that — claiming an OSI license we don't have would
 * undercut the exact thing publishing the code was meant to buy.
 */
export const REPO_LICENSE = "Functional Source License";
/** What FSL converts to, and when. Stated on the page because the clock is the point. */
export const REPO_LICENSE_CONVERTS = "Apache 2.0";

export const ABOUT_PAGE: ProsePageContent = {
  eyebrow: "About",
  title: "About ColdStorage",
  intro:
    "ColdStorage is somewhere to put the photos and files you want to keep but don't need open all the time. It's a Mac app and a yearly plan.",
  blocks: [
    {
      heading: "Why we built it",
      body: [
        "Everyone ends up with a pile of things they can't bring themselves to delete — old photos, video from a trip, scans of documents, the folder from a job that ended years ago. The usual answer is a cloud drive, which charges you to keep all of it awake and instantly openable even though you'll open almost none of it. So people buy an external drive instead, and then the drive dies, or it doesn't die but nobody can remember which drive it was.",
        // Comparative, never a figure: an earlier draft claimed "a few terabytes costs less per
        // year than most drives cost per month", which is arithmetic that doesn't survive
        // contact with either our prices or a drive's. Numbers live on /pricing.
        "ColdStorage is the other option. Your files go into deep storage, which is slow to open and much cheaper to keep than storage that stays live and ready all the time. Getting something back takes about 48 hours.",
      ],
    },
    {
      heading: "We can't read your files",
      body: [
        "Files are encrypted on your Mac before they upload, and the key that opens them never comes to us. That's a design choice with a real cost attached: if you lose your recovery code and your Mac, nobody can open your files, and that includes us. We'd rather say so plainly than leave you to find out later.",
      ],
    },
    {
      heading: "How we make money",
      body: [
        "You pay for storage once a year, and that's the whole business. There are no ads, and there's nothing to learn from your files even if we wanted to, because we can't open them.",
        "Pulling files back out is billed at what it costs us to move them, with nothing added on top.",
      ],
    },
    {
      heading: "What we won't do",
      body: [
        "We don't upload anything you didn't put in. macOS will hand an app access to your entire photo library if you let it, but we only take the files you actually drop in.",
      ],
    },
    {
      heading: "Who's behind it",
      body: ["ColdStorage is made by one person, in Burlington, Ontario, Canada."],
    },
  ],
  cta: { label: "Download for Mac", note: "Start with 25 GB free." },
};

/*
 * `/source` — formerly `/open-source`, renamed 2026-07-18 along with the license change. The
 * page's whole job is to make the encryption claim checkable, so the one thing it must not do
 * is overstate what the license actually grants. See the `REPO_LICENSE` note above.
 */
export const OPEN_SOURCE_PAGE: ProsePageContent = {
  eyebrow: "Source code",
  title: "You can read the code",
  intro:
    "All of ColdStorage is on GitHub — the Mac app, the daemon that does the encrypting and uploading, the account service, and this website.",
  blocks: [
    {
      heading: "Why it's public",
      body: [
        "We tell you your files are encrypted before they leave your Mac and that we never get the key. That's a claim, and a claim about encryption isn't worth much if you have to take our word for it. The code is there, so you can go and check instead.",
      ],
    },
    {
      heading: "Where to look",
      body: [
        "The encryption lives in the ColdStorageCore package. Crypto.swift does the per-file envelope encryption, and ZeroKnowledgeKeys.swift is the part that wraps your master key under your recovery code so that only that code can unwrap it. Those two files are where “only you hold the key” is either true or it isn't.",
      ],
    },
    {
      heading: "The license, and what it doesn't say",
      body: [
        `The code is under the ${REPO_LICENSE}. You can read it, run it, change it, and build on it. The one thing you can't do is use it to run a storage service that competes with ours.`,
        `Two years after we ship any given version, that restriction lapses and the version becomes ${REPO_LICENSE_CONVERTS} — a normal open source license, automatically, whether we're still here or not.`,
        "That's a real limit, so we're not going to call this open source. It isn't.",
      ],
    },
    {
      heading: "Running your own copy",
      body: [
        "The paid service is still a service. Readable code doesn't come with storage attached — running your own means bringing your own storage account and paying for that directly.",
      ],
    },
    {
      heading: "We're not taking contributions",
      body: [
        "Not for now. It's a small operation, and reviewing patches is time that isn't going into the app. Issues are still worth opening if you find something broken.",
        "If you find a security problem, email it to us instead of opening a public issue, and give us a chance to fix it before you write it up.",
      ],
    },
  ],
  cta: { label: "Read the code on GitHub", note: REPO_URL.replace("https://", "") },
};

/* ──────────────────────────────  Help center  ───────────────────────────── */

/** Same shape as a FAQ item, deliberately — the help groups render through the DS Accordion. */
export type HelpItem = FaqItem;
export type HelpGroup = { heading: string; items: HelpItem[] };
export type HelpPage = PageHeadContent & {
  groups: HelpGroup[];
  /** The sign-off that points at a human. */
  footer: { text: string; linkLabel: string };
};

/*
 * Longer answers than the landing FAQ gives — /faq sells, this explains. Deliberately absent:
 * "what happens if I stop paying" and "what happens if ColdStorage shuts down". Both are on the
 * FAQ backlog precisely because the answer isn't decided yet, and a help center is the worst
 * possible place to guess.
 */
export const HELP_PAGE: HelpPage = {
  eyebrow: "Support",
  title: "Help center",
  intro:
    "The things people actually run into, answered at length. If yours isn't here, send us a message.",
  groups: [
    {
      heading: "Getting started",
      items: [
        {
          question: "How do I install it?",
          answer:
            "Download the app, drag ColdStorage into your Applications folder, and open it. It runs on macOS, and there's no Windows or iPhone app yet.",
        },
        {
          question: "How do I sign in? I never set a password.",
          answer:
            "There isn't one. You type your email address, we send you a code, and you type the code back in.",
        },
        {
          question: "What is the recovery code, and why does it matter so much?",
          answer:
            "When you create your account you're shown a one-time recovery code. It's the only human-held secret in the whole system — it's what unwraps the key your files are encrypted with, and we don't keep a copy, because keeping one would mean we could open your files. Write it down somewhere that isn't the Mac you're backing up. You need it when you set ColdStorage up on a new computer. If you lose both the code and the Mac you first used, the files can't be opened by anyone.",
        },
      ],
    },
    {
      heading: "Putting files in",
      items: [
        {
          question: "How do I add files?",
          answer:
            "Drag them anywhere into the My Files window. Folders come in with their structure intact, and everything is encrypted on your Mac before any of it uploads.",
        },
        {
          question: "Does it back up my whole Mac automatically?",
          answer:
            "No, and it won't start doing that on its own. Only what you drop in gets uploaded. If you'd rather not drag things in by hand, you can point the app at a folder in Settings and new files in it will upload as they appear.",
        },
        {
          question: "Can I reorganize things after they're uploaded?",
          answer:
            "Yes, and it's free and instant. Renaming, moving, and nesting all happen in your file list, not in deep storage — nothing has to come back out and nothing re-uploads.",
        },
      ],
    },
    {
      heading: "Getting files back",
      items: [
        {
          question: "How do I get a file back?",
          answer:
            // No "sooner if you pay to hurry it" — we don't sell expedited retrieval, and the
            // landing page dropped that promise for the same reason. Bulk is the only tier V1
            // sells, and ~48 hours is its real wait.
            "Right-click it in My Files and choose Request a copy. The file is brought up out of deep storage and is ready in about 48 hours. You'll see what it costs before anything starts.",
        },
        {
          question: "Why isn't it instant?",
          answer:
            "Deep storage keeps your files resting rather than live and spinning, which is the entire reason it's cheap. Waking one up takes hours. There's a longer explanation on the How deep storage works page.",
        },
        {
          question: "What does getting files back cost?",
          answer:
            // Rates MUST match PRICING.retrievalRows exactly — asserted by copy-check.ts. They
            // look untidy on purpose: $0.0974 is not $0.09 and $0.53 is not $0.50 (see the note
            // on retrievalRows). Retrieval runs at 0% margin, so a rounded number is a lie in
            // one direction or the other.
            "Each month, the first 1 GB is free on a paid plan and the first 200 MB is free on the free plan. Past that it's $0.0974 per GB plus a $0.53 fee per recovery. Those rates are what it costs us to move the data, card processing included, and we don't add anything on top. The exact total is shown before you confirm.",
        },
        {
          question: "Do I have to wait just to see what's in there?",
          answer:
            "No. Browsing is always instant. Your file list lives on your Mac, so you can look through everything, search it, and reorganize it whenever you like. The wait only happens when you ask for a file's actual contents.",
        },
        {
          question: "Can I get everything out and leave?",
          answer:
            "Yes. You can export your whole archive and take it wherever you want. You'd pay the same per-GB cost to move that much data, and that's the only thing standing in the way.",
        },
      ],
    },
    {
      heading: "Plans and billing",
      items: [
        {
          question: "How do I change my plan?",
          answer:
            "Open Settings and go to the Account tab. You can move up or down a size there, and the change takes effect on your next renewal.",
        },
        {
          question: "When do plans renew?",
          answer: "Once a year. We email you before it happens, not after.",
        },
        {
          question: "Can I get a refund?",
          answer:
            "Usually, yes. The refund policy page has the specifics, and if your situation isn't covered there, write to us and we'll sort it out.",
        },
      ],
    },
  ],
  footer: {
    text: "Still stuck, or your question isn't here?",
    linkLabel: "Send us a message",
  },
};

/* ─────────────────────────────────  Contact  ────────────────────────────── */

export type ContactPage = PageHeadContent & {
  /** The two published addresses, for people who'd rather use their own mail client. */
  addresses: { label: string; email: string; note: string }[];
  responseNote: string;
  form: {
    name: { label: string; placeholder: string };
    email: { label: string; placeholder: string };
    message: { label: string; placeholder: string };
    submit: string;
    submitting: string;
    /** Shown in place of the form once the message is away. */
    success: { title: string; body: string };
    /** Client + server validation messages, and the catch-all failure. */
    errors: {
      name: string;
      email: string;
      message: string;
      turnstile: string;
      failed: string;
    };
  };
};

export const CONTACT_PAGE: ContactPage = {
  eyebrow: "Contact",
  title: "Get in touch",
  intro:
    "Questions about the app, your account, or a bill all land in the same inbox. Write what's going on and we'll reply by email.",
  addresses: [
    {
      label: "Support",
      email: SUPPORT_EMAIL,
      note: "The app, your account, billing — anything that isn't working.",
    },
    {
      label: "Privacy and legal",
      email: LEGAL_EMAIL,
      note: "Data requests, privacy questions, and anything a lawyer wrote.",
    },
  ],
  responseNote: "We answer most messages within a couple of business days.",
  form: {
    name: { label: "Your name", placeholder: "" },
    email: { label: "Your email", placeholder: "so we can write back" },
    message: { label: "Message", placeholder: "" },
    submit: "Send message",
    submitting: "Sending…",
    success: {
      title: "Message sent",
      body: "It's in the inbox. You'll get a reply at the address you gave us.",
    },
    errors: {
      name: "Add your name so we know who we're writing back to.",
      email: "That email address doesn't look right — we need a working one to reply to.",
      message: "Tell us what's going on and we'll take it from there.",
      turnstile: "The spam check didn't go through. Reload the page and try once more.",
      failed:
        "That didn't send, and it's on our end rather than yours. Try again in a minute, or email us directly at " +
        SUPPORT_EMAIL +
        ".",
    },
  },
};

/* ────────────────────────────────  Download  ─────────────────────────────── */

/**
 * `/download` serves two arrivals and says something different to each — see the route for
 * which CTA sends which. These strings used to be typed inline in the route, the only marketing
 * head copy that lived outside this file; they moved here when the page picked up a `PageHero`.
 */
export type DownloadPage = {
  /** The visitor pressed a button that said "Download", so the file is already on its way. */
  started: PageHeadContent;
  /** The visitor pressed "Get started" / "Choose", which read like navigation. Nothing fetched. */
  waiting: PageHeadContent;
  note: string;
  actions: { start: string; startAgain: string; releases: string };
};

export const DOWNLOAD_PAGE: DownloadPage = {
  started: {
    eyebrow: "ColdStorage for Mac",
    title: "Your download should start shortly",
    intro:
      "If it doesn't start on its own, use the button below. Once it lands, open the .dmg and drag ColdStorage into Applications — then open the app and drag in what you want to keep.",
  },
  waiting: {
    eyebrow: "ColdStorage for Mac",
    title: "Download ColdStorage",
    intro:
      "Hit the button and the .dmg starts downloading. Open it, drag ColdStorage into Applications, then open the app and drag in what you want to keep — that's the whole setup.",
  },
  note: "Free app · macOS 14 or later · storage from $9.99 a year",
  actions: {
    start: "Download for Mac",
    startAgain: "Download again",
    releases: "All releases",
  },
};

/* ─────────────────────────────  Brand (/brand)  ──────────────────────────── */

/*
 * `/brand` — the brand board: the mark, the wordmark, the lockups, the app icon and the mark's
 * palette. Translated from the "Coldstorage Brand Board" design (imported 2026-07-20).
 *
 * It is a reference page, not a sales page: it exists so anyone writing about ColdStorage or
 * building a surface for it uses the right mark on the right ground. So the copy here is
 * instructional rather than persuasive — it describes construction and states rules.
 *
 * The hex values are deliberately NOT here. They come from `brand-palette.ts`, the same
 * constants the mark itself paints with; this file supplies only the words that label them.
 */

export type BrandSpecimen = {
  heading: string;
  /** The construction/usage rule shown under the specimen. */
  note: string;
};

export type BrandPage = PageHeadContent & {
  specimens: {
    logomark: BrandSpecimen;
    wordmark: BrandSpecimen;
    lockupHorizontal: BrandSpecimen;
    lockupStacked: BrandSpecimen;
    appIcon: BrandSpecimen;
    palette: BrandSpecimen;
  };
  /** Ground labels under each light/dark specimen pair. */
  grounds: { light: string; dark: string };
  /**
   * One caption per mark colour. Typed as a TOTAL record, so adding a colour to
   * `BRAND_MARK_PALETTE` breaks the build here until it has a name (PILLAR4).
   */
  swatches: Record<BrandColorKey, string>;
  /** Scale labels beside the app-icon specimen. */
  iconScales: { master: string; home: string };
};

export const BRAND_PAGE: BrandPage = {
  eyebrow: "Brand",
  title: "The ColdStorage brand",
  intro:
    "The mark, the wordmark and how they go together. If you're writing about ColdStorage or building something that shows it, take what you need from here.",
  specimens: {
    logomark: {
      heading: "Logomark",
      note: "Three frost planes inside a rounded keyline hex. The planes are identical in both cuts — only the outline changes, so the mark holds its weight on a dark ground instead of glaring.",
    },
    wordmark: {
      heading: "Wordmark",
      note: "Always lowercase — the wordmark is a drawn thing, so it doesn't take a capital at the start of a sentence. Written out in prose it's ColdStorage. Outfit at 600, tracking pulled to -0.015em, brand ink on light grounds and white on dark.",
    },
    lockupHorizontal: {
      heading: "Horizontal lockup",
      note: "The default pairing — navigation bars, letterheads, anywhere with more width than height. Mark at 1.4× the wordmark's cap height, with a gap of roughly half the mark's width.",
    },
    lockupStacked: {
      heading: "Stacked lockup",
      note: "For splash screens, merch and anywhere the horizontal lockup would have to shrink to fit.",
    },
    appIcon: {
      heading: "App icon",
      note: "The dark cut on the vault tile. One icon at every size — it holds together from the home screen down to a settings row.",
    },
    palette: {
      heading: "Palette",
      note: "The mark's own colours. These build the cube; the interface palette is a separate system.",
    },
  },
  grounds: { light: "On light", dark: "On dark" },
  swatches: {
    cubeTop: "Cube top plane",
    cubeLeft: "Cube left plane",
    cubeRight: "Cube right plane",
    outlineLight: "Outline — light ground",
    outlineDark: "Outline — dark ground",
  },
  iconScales: { master: "1024 master", home: "Home screen" },
};

/* ────────────────────────────────  Footer  ──────────────────────────────── */

export type FooterLink = { label: string; href?: string };
export type FooterColumn = { heading: string; links: FooterLink[] };
export type Footer = {
  tagline: string;
  columns: FooterColumn[];
  legal: FooterLink[];
  copyright: string;
};

export const FOOTER: Footer = {
  tagline: "For the photos and files you want kept.",
  columns: [
    {
      heading: "Product",
      links: [
        { label: "How it works", href: "/how-it-works" },
        { label: "Pricing", href: "/pricing" },
        { label: "FAQ", href: "/faq" },
      ],
    },
    // "Transparency notes" and "Status" are gone (Ben, 2026-07-18). Neither had a page behind
    // it, and a Status link that isn't a real status page is worse than no link at all.
    {
      heading: "Company",
      links: [
        { label: "About", href: "/about" },
        // Label says "Source code", not "Open source" — the license is source-available.
        { label: "Source code", href: "/source" },
        { label: "Brand", href: "/brand" },
      ],
    },
    {
      heading: "Support",
      links: [
        { label: "Help center", href: "/help" },
        { label: "Contact us", href: "/contact" },
      ],
    },
  ],
  legal: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "Refunds", href: "/refunds" },
  ],
  copyright: "© 2026 ColdStorage",
};
