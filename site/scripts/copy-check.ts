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
  BRAND_PAGE,
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
  NAV_LINKS,
  FOOTER,
} from "../app/lib/marketing/content";
import type { ProsePageContent } from "../app/lib/marketing/content";
import { COMPARISON_VERIFIED_ON } from "../app/lib/marketing/content";
import { INDEXABLE_ROUTES, NON_INDEXABLE_ROUTES } from "../app/lib/marketing/site-routes";
import { readdirSync } from "node:fs";
// Namespace import as well as the named ones: rule 4a scans every exported string, so it must
// see exports nobody thought to enumerate.
import * as CONTENT from "../app/lib/marketing/content";

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

/* ── 1a · The hero's price matches the entry plan ────────────────────────────
   HERO.lead quotes a live figure ("$9.99 per year for 500 GB"). That is the ladder's cheapest
   paid row, so it is derived here rather than trusted — a headline price that drifts off the
   pricing table is the most expensive kind of stale copy, and it sits on the first screen.
   The check is on the STRINGS appearing in the lead, not on its wording, so the sentence stays
   free to change. */
const entryPlan = PLAN_SIZES.reduce((a, b) => (a.perYearCents <= b.perYearCents ? a : b));
const entryPrice = centsToUsd(entryPlan.perYearCents);
if (!HERO.lead.includes(entryPrice)) {
  fail(
    "hero-price-matches-entry-plan",
    `HERO.lead should quote the entry plan's price ${entryPrice} (${entryPlan.size}) — it says "${HERO.lead}"`,
  );
}
if (!HERO.lead.includes(entryPlan.size)) {
  fail(
    "hero-price-matches-entry-plan",
    `HERO.lead quotes a price but not the size it buys — expected "${entryPlan.size}"`,
  );
}
/* A bare "$9.99" reads as MONTHLY to anyone who has seen iCloud or Dropbox, which misprices us
   by 12x on the first screen. The period has to be on the line. */
if (!/\bper year\b|\ba year\b|\/yr\b|\byearly\b/i.test(HERO.lead)) {
  fail(
    "hero-price-states-the-period",
    `HERO.lead quotes ${entryPrice} without saying it is yearly — a bare figure reads as monthly`,
  );
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
  // The headline is reassembled from its three parts so the brand rules see the whole sentence,
  // not the fragments — "can't afford" only reads right with the words either side of it.
  [
    "HERO",
    [HERO.lead, HERO.note, HERO.cta, HERO.headline.before, HERO.headline.accent, HERO.headline.after].join(" "),
  ],
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
  // /brand (2026-07-20). Instructional rather than persuasive, but it is still rendered copy,
  // so the standing rules apply — including the casing rule it happens to describe.
  ["BRAND_PAGE", [BRAND_PAGE.intro, ...Object.values(BRAND_PAGE.specimens).flatMap((s) => [s.heading, s.note]), ...Object.values(BRAND_PAGE.swatches)].join(" ")],
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

/* ── 3b · Never position against "the cloud" ─────────────────────────────────
   We ARE cloud storage — files go over the internet to a data centre and sit on someone else's
   hardware. Copy that treats "the cloud" as the other guy argues against the thing we sell, and
   is simply untrue (Ben, 2026-07-20).

   The real contrast is instant-access storage vs. storage for files you rarely open — two tiers
   of one category, and we're the cheap one. So this bans the rejection constructions, not the
   word: "most cloud storage keeps your files live" and "a cloud drive charges you to keep it all
   awake" are correct and stay legal. */
const ANTI_CLOUD =
  /\b(?:(?:don'?t|doesn'?t|do not) need (?:the )?cloud|cheaper than (?:the )?cloud\b|instead of (?:the )?cloud|skip (?:the )?cloud|without (?:the )?cloud|not (?:the |a )?cloud\b|ditch (?:the )?cloud|beyond (?:the )?cloud)/i;
for (const [where, text] of allCopy) {
  const hit = text.match(ANTI_CLOUD);
  if (hit) {
    fail(
      "never-position-against-the-cloud",
      `${where} says "${hit[0]}" — we ARE cloud storage. Contrast instant-access vs. rarely-opened instead (see strategy/CANON.md §4)`,
    );
  }
}

/* ── 4a · The product name is capitalised in prose ───────────────────────────
   `coldstorage` lowercase is the WORDMARK — a drawn artifact rendered only by <Wordmark>.
   Written out in a sentence the product is `ColdStorage` (Ben, 2026-07-20).

   This scans the WHOLE content module rather than the curated `allCopy` list, because that
   list deliberately skips page titles and headings — and a heading is exactly where a
   lowercase brand would look most deliberate and be least questioned. Stringifying every
   export means a string added next month is covered without anyone remembering to add it.
   Domains and repo paths are legitimately lowercase, so URLs are stripped first. The rendered
   logotype is asserted separately, in `task ssr:check:site`. */
/** Every string reachable from the content module, with its path (e.g. `BRAND_PAGE.intro`). */
function collectStrings(node: unknown, at: string, out: [string, string][]): void {
  if (typeof node === "string") out.push([at, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => collectStrings(v, `${at}[${i}]`, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectStrings(v, at ? `${at}.${k}` : k, out);
  }
}
const everyString: [string, string][] = [];
collectStrings(CONTENT, "", everyString);

for (const [where, value] of everyString) {
  // Domains, repo paths and mail addresses are legitimately lowercase — drop them, then look
  // at what is left, which is prose.
  const prose = value
    // Any token carrying a slash: URLs, and repo paths like `github.com/benhonda/coldstorage`.
    .replace(/\S*\/\S*/g, " ")
    .replace(/\b[\w-]+\.(?:sh|com|io|dev)\b/gi, " ")
    .replace(/\S+@\S+/g, " ");
  if (/\bcoldstorage\b/.test(prose)) {
    fail(
      "product-name-is-capitalised",
      `${where} writes "coldstorage" in prose — the product is "ColdStorage"; lowercase is the wordmark only`,
    );
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

/* ── 7 · The sitemap knows about every page ─────────────────────────────────
   `INDEXABLE_ROUTES` is what `/sitemap.xml` is built from, so a page missing from it is a page
   crawlers are never told about. That failure is invisible — the page works, it just never gets
   found — which is exactly the kind of thing a guard is for. Anything deliberately left out has
   to say so in `NON_INDEXABLE_ROUTES`, so "omitted on purpose" and "forgotten" look different. */
const routeFiles = readdirSync(new URL("../app/routes/", import.meta.url));
const listedPaths = new Set(INDEXABLE_ROUTES.map((r) => r.path));

for (const file of routeFiles) {
  if (!file.endsWith(".tsx")) continue;
  // `($lang).how-it-works.tsx` → `/how-it-works`; `($lang)._index.tsx` → `/`.
  // Resource routes escape the dot (`sitemap[.]xml.tsx`) and aren't pages.
  if (file.includes("[.]")) continue;
  const path = file
    .replace(/^\(\$lang\)\./, "")
    .replace(/\.tsx$/, "")
    .replace(/^_index$/, "/")
    .replace(/^(?!\/)/, "/");

  if (!listedPaths.has(path) && !(path in NON_INDEXABLE_ROUTES)) {
    fail(
      "sitemap-covers-every-page",
      `${file} renders ${path}, which is in neither INDEXABLE_ROUTES nor NON_INDEXABLE_ROUTES ` +
        `(site-routes.ts) — so it will never appear in /sitemap.xml. Add it to one of them.`
    );
  }
}

/* ── 8 · Competitor pricing hasn't gone stale ───────────────────────────────
   `/compare` states a competitor's price, which is the one number on this site that no SSOT of
   ours can generate and no test can verify — it changes when they decide it does. (It already
   moved once: Dropbox and Google One both drifted out of the range our own strategy doc had
   recorded.) A wrong price on a comparison page is a claim someone can challenge, so the only
   real defence is forcing a human to re-check it on a clock. Six months is the window. */
const COMPETITOR_PRICE_MAX_AGE_DAYS = 183;
const verifiedOn = new Date(`${COMPARISON_VERIFIED_ON}T00:00:00Z`);
if (Number.isNaN(verifiedOn.getTime())) {
  fail("competitor-pricing-freshness", `COMPARISON_VERIFIED_ON is not a date: ${COMPARISON_VERIFIED_ON}`);
} else {
  const ageDays = Math.floor((Date.now() - verifiedOn.getTime()) / 86_400_000);
  if (ageDays > COMPETITOR_PRICE_MAX_AGE_DAYS) {
    fail(
      "competitor-pricing-freshness",
      `/compare quotes competitor pricing last checked ${COMPARISON_VERIFIED_ON} (${ageDays} days ago). ` +
        `Re-check it against the vendor's OWN pricing page — never a blog or memory — then update ` +
        `COMPARE_PAGE.table and COMPARISON_VERIFIED_ON in content.ts.`
    );
  }
}

/* ── 9 · No orphan pages ────────────────────────────────────────────────────
   Being in the sitemap is not the same as being reachable. A page with no inbound link is an
   orphan: crawlers treat zero internal links as a signal it doesn't matter, and no visitor can
   reach it at all. This is exactly how `/compare` shipped — sitemapped, rendered, SSR-checked,
   and linked from nowhere.

   "Reachable" here means the site chrome points at it: the nav, the footer's columns, or the
   footer's legal row. In-body prose links are deliberately NOT counted — prose gets rewritten,
   and a page whose only route in is one sentence is one edit away from being orphaned again. */
// `FooterLink.href` is optional (a column can carry a label with nothing behind it), so the
// undefined ones are filtered out rather than cast away.
const chromeHrefs = new Set<string>(
  [
    ...NAV_LINKS.map((l) => l.href),
    ...FOOTER.columns.flatMap((c) => c.links.map((l) => l.href)),
    ...FOOTER.legal.map((l) => l.href),
  ].filter((href): href is string => typeof href === "string")
);

for (const { path } of INDEXABLE_ROUTES) {
  // The home page is reached by the wordmark in the nav, which is a component, not a link entry.
  if (path === "/") continue;
  // `/download` is the CTA on every page (the primary conversion action), not a chrome link.
  if (path === "/download") continue;

  if (!chromeHrefs.has(path)) {
    fail(
      "no-orphan-pages",
      `${path} is in INDEXABLE_ROUTES but nothing in the nav or footer links to it. It would ` +
        `be sitemapped, crawlable, and unreachable. Add it to NAV_LINKS or FOOTER.columns.`
    );
  }
}

/* ── 10 · No unsubstantiated superlatives ───────────────────────────────────
   CANON §6 bans these and nothing enforced it until now.

   Two independent reasons, and the first is the one that matters: several would be **false**.
   Running storage infrastructure yourself is genuinely cheaper than us, and an unlimited backup
   plan wins at high terabyte counts — so "cheapest" is a comparative claim we'd lose. "Safest"
   and "most secure" are unfalsifiable and invite a legal argument we have no reason to have.

   The second: superlatives are the least citable thing a page can carry. Answer engines quote
   figures and sourced statements; "we're the best" is filtered as marketing. The honest numeric
   version of the claim outperforms the superlative at the very job the superlative was reached
   for. See the "Is this the cheapest way to store my files?" FAQ entry for the pattern.

   Scanned across every exported string, same sweep rule 4a uses — a superlative is just as
   damaging in a help answer as in the hero. */
const SUPERLATIVES =
  /\b(cheapest|best|safest|most secure|unhackable|bulletproof|military[- ]grade|bank[- ]level|100% (safe|secure|private)|fastest|only .{0,20}(that can|who can))\b/i;

for (const [where, text] of everyString) {
  /* FAQ *questions* are exempt; FAQ *answers* are not.
     A question is the visitor's words, not ours — "Is this the cheapest way to store my files?"
     is the query people actually type, and matching that phrasing is exactly why the entry
     earns the query. The claim would live in the answer, which is still scanned below, and
     that answer is where the honest "cheaper than X, not cheaper than Y" belongs. */
  if (/\.question$/.test(where)) continue;

  const hit = text.match(SUPERLATIVES);
  if (hit) {
    fail(
      "no-unsubstantiated-superlatives",
      `${where} says "${hit[0]}". CANON §6 bans it — and for the cost claims it would also be ` +
        `untrue (self-run infrastructure and unlimited plans both undercut us). State the ` +
        `number and let it make the point.`
    );
  }
}

/* ── report ─────────────────────────────────────────────────────────────────── */
const CHECKS = 18;
if (failures.length === 0) {
  console.log(`✓ copy check passed — ${CHECKS} rules, ${PRICING.tiers.length} tiers verified`);
  process.exit(0);
}
console.error(`✗ copy check failed — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  [${f.rule}]\n    ${f.detail}`);
console.error("\nRules live in app/lib/marketing/content.ts (header) and site/SPEC.md → Layer D.");
process.exit(1);
