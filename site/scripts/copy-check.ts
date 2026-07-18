/**
 * Copy guard — asserts the marketing copy SSOT (`app/lib/marketing/content.ts`) still obeys
 * the constraints that govern it. Run via `task copy:check:site`.
 *
 * Copy is never settled; that's the point. These checks exist so the things that AREN'T
 * negotiable survive the churn — the standing brand rules, and the numbers that belong to
 * another SSOT. Each check names the rule it enforces so a failure explains itself.
 *
 * Why a checker and not a generator: prices live in `account-backend` (its own package, its own
 * deploy) and words are written by hand. Generating either from the other would couple two
 * deploy targets to buy less than this costs. See site/SPEC.md → Layer D.
 */
import { PLAN_SIZES } from "../../account-backend/src/plan-sizes";
import {
  quoteCents,
  ALLOWANCE_BYTES_SUBSCRIBED,
  ALLOWANCE_BYTES_FREE,
} from "../../account-backend/src/retrieval-pricing";
import {
  FAQ,
  HOW_PAGE,
  PRICING,
  HERO,
  HOW,
  PRIVACY,
  CLOSE,
  ABOUT_PAGE,
  OPEN_SOURCE_PAGE,
  HELP_PAGE,
  CONTACT_PAGE,
  REPO_LICENSE,
} from "../app/lib/marketing/content";
import type { ProsePageContent } from "../app/lib/marketing/content";

type Failure = { rule: string; detail: string };
const failures: Failure[] = [];
const fail = (rule: string, detail: string) => failures.push({ rule, detail });

/* ── 1 · Prices mirror the code SSOT ─────────────────────────────────────────
   `plan-sizes.ts` is generator-derived ($0.018/GB/yr + $0.99) and feeds the Paddle catalog.
   The site hand-mirrors it because the packages aren't linked — so verify, every run. */
const centsToUsd = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

for (const { size, perYearCents } of PLAN_SIZES) {
  const tier = PRICING.tiers.find((t) => t.size === size);
  if (!tier) {
    fail("prices-mirror-plan-sizes", `PLAN_SIZES has "${size}" but PRICING.tiers does not`);
    continue;
  }
  const want = centsToUsd(perYearCents);
  if (tier.year !== want) {
    fail("prices-mirror-plan-sizes", `"${size}": plan-sizes says ${want}, site says ${tier.year}`);
  }
  // `month` is presentational (year / 12) — check it tracks, to the cent.
  const wantMonth = centsToUsd(Math.round(perYearCents / 12));
  if (tier.month !== wantMonth) {
    fail("prices-mirror-plan-sizes", `"${size}": monthly should be ${wantMonth}, site says ${tier.month}`);
  }
}

// Paid tiers on the site that no longer exist in the catalog (the free tier is site-only).
for (const tier of PRICING.tiers.filter((t) => !t.free)) {
  if (!PLAN_SIZES.some((p) => p.size === tier.size)) {
    fail("prices-mirror-plan-sizes", `site sells "${tier.size}" but PLAN_SIZES has no such row`);
  }
}

/* ── 1b · Retrieval rates are the REAL, all-in rates ─────────────────────────
   Retrieval runs at 0% margin, so a published rate that's been tidied to a rounder number is
   either a subsidy out of storage margin or margin we said we don't take. Both directions are
   wrong, so these are DERIVED from `quoteCents()` rather than compared to a hardcoded copy.
   (The site shipped $0.09/GB + $0.50 flat — the raw AWS egress cost with the thaw and Paddle
   gross-up stripped off — until 2026-07-18.) */
const GiB = 1024 ** 3;
// A ~zero-byte job bills the flat fee alone; the 1000-GiB minus 1-GiB delta gives the marginal
// per-GB rate with the per-quote ceil averaged out.
const flatCents = quoteCents(0, 1);
const perGbCents = (quoteCents(1000 * GiB, 1000 * GiB) - quoteCents(1 * GiB, 1 * GiB)) / 999;

const expectFlat = `$${(flatCents / 100).toFixed(2)}`;
// Dollars, never cents — a "9.74¢" style rate reads as a different unit beside "$0.53".
const expectPerGb = `$${(perGbCents / 100).toFixed(4)}`;
const gbRow = PRICING.retrievalRows.find((r) => /every gb/i.test(r.label));
const flatRow = PRICING.retrievalRows.find((r) => /flat fee/i.test(r.label));

if (gbRow?.value !== expectPerGb) {
  fail("retrieval-rates-are-real", `per-GB rate should be ${expectPerGb} (from quoteCents), site says ${gbRow?.value}`);
}
if (flatRow?.value !== expectFlat) {
  fail("retrieval-rates-are-real", `flat fee should be ${expectFlat} (from quoteCents), site says ${flatRow?.value}`);
}

// The free allowance quoted in copy must match the allowance the backend actually grants.
const freeRow = PRICING.retrievalRows.find((r) => /free/i.test(r.value));
const allowanceGb = ALLOWANCE_BYTES_SUBSCRIBED / 1_000_000_000;
if (freeRow && !new RegExp(`${allowanceGb}\\s*GB`, "i").test(freeRow.label)) {
  fail("retrieval-rates-are-real", `free allowance row says "${freeRow.label}" but paid plans get ${allowanceGb} GB`);
}
const freeMb = ALLOWANCE_BYTES_FREE / 1_000_000;
if (!new RegExp(`${freeMb}\\s*MB`, "i").test(PRICING.finePrint)) {
  fail("retrieval-rates-are-real", `finePrint should state the ${freeMb} MB free-tier allowance`);
}

/* ── 2 · Never name the backend provider in customer copy ────────────────────
   Firm reversal, Ben 2026-07-17. Legal disclosure (`legal.ts`) is the carve-out and is
   deliberately not scanned here. */
const PROVIDER = /\b(aws|amazon|s3|glacier|deep archive)\b/i;
const allCopy: [string, string][] = [
  ["HERO", [HERO.lead, HERO.note, HERO.cta, ...HERO.words].join(" ")],
  ["HOW", [HOW.title, HOW.body].join(" ")],
  ["PRIVACY", [PRIVACY.lead, ...PRIVACY.steps.flatMap((s) => [s.title, s.body])].join(" ")],
  ["PRICING", [PRICING.retrievalLead, PRICING.callout, PRICING.finePrint, PRICING.readyNote].join(" ")],
  ["FAQ", FAQ.items.flatMap((i) => [i.question, i.answer]).join(" ")],
  ["HOW_PAGE", [HOW_PAGE.intro, ...HOW_PAGE.blocks.flatMap((b) => [b.heading, ...b.body])].join(" ")],
  ["CLOSE", [CLOSE.title, CLOSE.lead].join(" ")],
  // The Company + Support pages (2026-07-18). They carry the longest, least-reviewed prose on
  // the site, which makes them the most likely place for a banned word to slip back in.
  ["ABOUT_PAGE", prose(ABOUT_PAGE)],
  ["OPEN_SOURCE_PAGE", prose(OPEN_SOURCE_PAGE)],
  ["HELP_PAGE", [HELP_PAGE.intro, ...HELP_PAGE.groups.flatMap((g) => [g.heading, ...g.items.flatMap((i) => [i.question, i.answer])])].join(" ")],
  ["CONTACT_PAGE", [CONTACT_PAGE.intro, CONTACT_PAGE.responseNote, ...CONTACT_PAGE.addresses.map((a) => a.note)].join(" ")],
];

/** Flatten a headed-prose page (title excluded — the intro and blocks are the copy). */
function prose(page: ProsePageContent): string {
  return [page.intro, ...page.blocks.flatMap((b) => [b.heading, ...b.body])].join(" ");
}

/* ── The source page never claims "open source" ──────────────────────────────
   The repo is under FSL-1.1-ALv2 — SOURCE-AVAILABLE, not an OSI license (Ben, 2026-07-18).
   The page exists to make the encryption claim checkable, so overstating the license there is
   the one failure that would poison the whole point of publishing the code.

   Two halves, because a blanket ban on the phrase can't work: the page legitimately says the
   FSL "becomes Apache 2.0 — a normal open source license" when describing the conversion.
   So instead: the LABELS a reader scans must not say it, and the explicit disclaimer must
   still be there. */
const labels = [
  OPEN_SOURCE_PAGE.eyebrow,
  OPEN_SOURCE_PAGE.title,
  OPEN_SOURCE_PAGE.cta.label,
  ...OPEN_SOURCE_PAGE.blocks.map((b) => b.heading),
].join(" ");
if (/open[- ]source/i.test(labels)) {
  fail(
    "source-page-never-claims-open-source",
    `OPEN_SOURCE_PAGE has "open source" in a heading/label — the license is source-available (FSL)`
  );
}

// The disclaimer sentence is the whole reason the page is trustworthy. Cutting it is a
// regression, not an edit — same standing as PRICING.readyNote.
const disclaimer = /not going to call (this|it) open source|isn't open source|is not open source/i;
if (!disclaimer.test(prose(OPEN_SOURCE_PAGE))) {
  fail(
    "source-page-never-claims-open-source",
    `OPEN_SOURCE_PAGE dropped its "we're not going to call this open source" line — keep it`
  );
}

// And the license named in prose must match the root LICENSE file's actual license.
if (!prose(OPEN_SOURCE_PAGE).includes(REPO_LICENSE)) {
  fail(
    "source-page-names-the-real-license",
    `OPEN_SOURCE_PAGE never names "${REPO_LICENSE}" — it must state the license it actually ships under`
  );
}

for (const [where, text] of allCopy) {
  const hit = text.match(PROVIDER);
  if (hit) fail("never-name-the-provider", `${where} mentions "${hit[0]}"`);
}

/* ── 3 · No "safe"/"secure" claims ───────────────────────────────────────────
   Brand rule: calm and factual. We say what happens, not that it's safe. */
const OVERCLAIM = /\b(safe|secure|guaranteed|bulletproof|100%)\b/i;
for (const [where, text] of allCopy) {
  const hit = text.match(OVERCLAIM);
  if (hit) fail("no-overclaims", `${where} uses "${hit[0]}"`);
}

/* ── 4 · Terminology + cost-framing rules ────────────────────────────────────
   Voice deltas (2026-07-17): "encrypted" not "scrambled" — the design's `LC` still carries
   the old word, so this catches it re-entering on a re-pull. And never frame our own costs as
   nothing: it reads as "then why am I paying you", and it isn't true. */
for (const [where, text] of allCopy) {
  if (/\bscrambl\w*/i.test(text)) {
    fail("say-encrypted-not-scrambled", `${where} says "scrambled" — the word is "encrypted"`);
  }
  const cheapHit = text.match(/\b(nearly free|basically nothing|costs us nothing|practically free)\b/i);
  if (cheapHit) {
    fail("no-costs-us-nothing", `${where} frames our cost as "${cheapHit[0]}" — explain cheapness comparatively`);
  }
}

/* ── 4b · Money is always written in dollars ─────────────────────────────────
   A sub-dollar rate goes as "$0.0974", not "9.74¢" — mixing units in one table makes two
   prices look like two different kinds of thing. Precision is kept; only the unit is fixed. */
const moneyStrings = [
  ...PRICING.retrievalRows.map((r) => [`retrievalRows["${r.label}"]`, r.value] as const),
  ...PRICING.tiers.flatMap((t) => [
    [`tiers["${t.size}"].year`, t.year] as const,
    [`tiers["${t.size}"].month`, t.month] as const,
  ]),
  ["finePrint", PRICING.finePrint] as const,
  ["callout", PRICING.callout] as const,
];
for (const [where, value] of moneyStrings) {
  if (/¢|\bcents?\b/i.test(value)) {
    fail("money-in-dollars", `${where} = "${value}" — write it in dollars, e.g. $0.0974`);
  }
}

/* ── 5 · /how-it-works stays free of dollar figures ──────────────────────────
   Page-specific: the cost story is qualitative there; numbers live on /pricing. */
const howPageText = [HOW_PAGE.intro, ...HOW_PAGE.blocks.flatMap((b) => b.body)].join(" ");
if (/\$\d/.test(howPageText)) {
  fail("how-it-works-no-dollar-figures", "HOW_PAGE contains a $ figure — those belong on /pricing");
}

/* ── 6 · The not-instant expectation survives ────────────────────────────────
   `readyNote` is the ONLY place the landing page sets the "not instant" expectation.
   Standing rule from the copy review: don't cut it. */
if (!/48 hours|day or two/i.test(PRICING.readyNote)) {
  fail(
    "keep-honest-ready-note",
    "PRICING.readyNote no longer sets the not-instant expectation — it's the only place the landing page does"
  );
}

/* ── The help center quotes the SAME retrieval numbers as /pricing ───────────
   `/help` restates the retrieval rates in prose, which makes it a second place for numbers
   that belong to `quoteCents()`. It drifted within hours of being written (it shipped saying
   "$0.09 per GB plus a $0.50 fee" while the real rates were $0.0974 and $0.53), so the two are
   pinned together here rather than left to a reviewer's memory. */
const helpProse = HELP_PAGE.groups
  .flatMap((g) => g.items.map((i) => i.answer))
  .join(" ");
for (const row of PRICING.retrievalRows) {
  if (row.value === "Free") continue; // the allowance is worded, not quoted, in the help copy
  if (!helpProse.includes(row.value)) {
    fail(
      "help-quotes-real-retrieval-rates",
      `HELP_PAGE never states ${row.value} ("${row.label}") — it must match /pricing exactly, untidied`
    );
  }
}

/* ── report ─────────────────────────────────────────────────────────────────── */
const CHECKS = 10;
if (failures.length === 0) {
  console.log(`✓ copy check passed — ${CHECKS} rules, ${PRICING.tiers.length} tiers verified`);
  process.exit(0);
}
console.error(`✗ copy check failed — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}]\n    ${f.detail}`);
console.error("\nRules live in app/lib/marketing/content.ts (header) and site/SPEC.md → Layer D.");
process.exit(1);
