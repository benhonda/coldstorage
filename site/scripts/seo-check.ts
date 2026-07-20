/**
 * SEO surface check — renders the machine-readable endpoints through the real production
 * server build and asserts they're actually well-formed. Run via `task seo:check:site`
 * (it builds first, same as `ssr:check:site`).
 *
 * Why this exists separately from `ssr-check.ts`: that script proves *pages* render. This one
 * covers the surface nobody looks at — `/robots.txt`, `/sitemap.xml`, and the JSON-LD in the
 * home page's head. All three fail silently by nature. A malformed sitemap doesn't 500, it just
 * quietly stops pages being crawled; broken JSON-LD doesn't break the page, it just stops the
 * structured data being read. Neither shows up in a browser, which is exactly why they rot.
 *
 * The checks are deliberately structural rather than exact-match: asserting the literal bytes
 * would make every copy tweak a test failure, which trains people to update the expectation
 * without reading it.
 */
import { createRequestHandler } from "react-router";
import { INDEXABLE_ROUTES, SITE_ORIGIN } from "../app/lib/marketing/site-routes.ts";

const BUILD = "../build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/index.js";

const failures: string[] = [];
const fail = (rule: string, detail: string) => failures.push(`[${rule}]\n    ${detail}`);

const build = await import(BUILD);
const handler = createRequestHandler(build, "production");

async function fetchText(path: string) {
  const res = await handler(new Request(`${SITE_ORIGIN}${path}`));
  return { res, body: await res.text() };
}

/* ── 1 · /robots.txt ───────────────────────────────────────────────────────── */
{
  const { res, body } = await fetchText("/robots.txt");

  if (res.status !== 200) fail("robots-serves", `/robots.txt returned ${res.status}`);
  if (!res.headers.get("content-type")?.includes("text/plain")) {
    fail("robots-content-type", `/robots.txt is ${res.headers.get("content-type")}, not text/plain`);
  }
  if (!body.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`)) {
    fail("robots-points-at-sitemap", "/robots.txt does not declare the sitemap URL");
  }

  /* The AI SEARCH crawlers specifically — these are the ones that produce citations, and they
     are NOT the same agents as the training crawlers people usually think of. Losing one of
     these lines removes us from that engine's answers, which is invisible until someone
     notices we're never cited. Asserted by name for that reason. */
  for (const ua of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"]) {
    if (!body.includes(`User-agent: ${ua}`)) {
      fail(
        "robots-allows-ai-search-crawlers",
        `${ua} is not named in /robots.txt. It is a SEARCH crawler — dropping it removes us ` +
          `from that engine's cited answers. (Not to be confused with the training crawlers.)`
      );
    }
  }
  if (/^\s*Disallow:\s*\/\s*$/m.test(body)) {
    fail("robots-not-blanket-blocked", "/robots.txt contains a blanket `Disallow: /`");
  }
}

/* ── 2 · /sitemap.xml ──────────────────────────────────────────────────────── */
{
  const { res, body } = await fetchText("/sitemap.xml");

  if (res.status !== 200) fail("sitemap-serves", `/sitemap.xml returned ${res.status}`);
  if (!res.headers.get("content-type")?.includes("xml")) {
    fail("sitemap-content-type", `/sitemap.xml is ${res.headers.get("content-type")}, not XML`);
  }
  if (!body.startsWith("<?xml")) fail("sitemap-well-formed", "/sitemap.xml has no XML declaration");

  const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  if (locs.length !== INDEXABLE_ROUTES.length) {
    fail(
      "sitemap-lists-every-indexable-route",
      `/sitemap.xml has ${locs.length} <loc> entries, INDEXABLE_ROUTES has ${INDEXABLE_ROUTES.length}`
    );
  }
  for (const loc of locs) {
    if (!loc.startsWith(`${SITE_ORIGIN}/`) && loc !== SITE_ORIGIN) {
      fail("sitemap-absolute-urls", `<loc>${loc}</loc> is not an absolute URL on ${SITE_ORIGIN}`);
    }
  }
}

/* ── 3 · Home-page JSON-LD ─────────────────────────────────────────────────── */
{
  const { body } = await fetchText("/");
  const blocks = [...body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];

  if (blocks.length === 0) fail("home-has-json-ld", "the home page emits no JSON-LD at all");

  const parsed: Record<string, unknown>[] = [];
  for (const [, raw] of blocks) {
    try {
      parsed.push(JSON.parse(raw));
    } catch (err) {
      fail("json-ld-parses", `a JSON-LD block on / is not valid JSON: ${(err as Error).message}`);
    }
  }

  const types = parsed.map((o) => o["@type"]);
  for (const want of ["Organization", "SoftwareApplication"]) {
    if (!types.includes(want)) fail("home-json-ld-types", `the home page has no ${want} node`);
  }

  const app = parsed.find((o) => o["@type"] === "SoftwareApplication") as
    | { offers?: { lowPrice?: string; offerCount?: number } }
    | undefined;
  if (app && !app.offers?.lowPrice) {
    fail("software-offers-have-prices", "SoftwareApplication.offers has no lowPrice");
  }

  /* No fabricated social proof, asserted against the machine-readable copy specifically. A
     rating in JSON-LD is a structured assertion that reviews exist; we have none. This is the
     one place a well-meaning "let's add rich results" edit would do real damage. */
  for (const o of parsed) {
    if ("aggregateRating" in o || "review" in o) {
      fail(
        "no-fabricated-ratings",
        `a JSON-LD node (${o["@type"]}) carries aggregateRating/review. ColdStorage has no ` +
          `customers yet — that is a machine-readable claim of reviews that do not exist.`
      );
    }
  }
}

/* ── report ────────────────────────────────────────────────────────────────── */
if (failures.length === 0) {
  console.log(
    `✓ SEO check passed — robots.txt, sitemap.xml (${INDEXABLE_ROUTES.length} routes), home JSON-LD`
  );
  process.exit(0);
}
console.error(`✗ SEO check failed — ${failures.length} problem(s):\n`);
for (const f of failures) console.error(`  ${f}`);
process.exit(1);
