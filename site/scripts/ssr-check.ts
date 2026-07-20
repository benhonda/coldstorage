/**
 * SSR smoke check — renders every marketing route through the real production server build
 * and asserts the page actually came out, then checks the things that only show up in rendered
 * HTML, then exercises the `/contact` action. Run via `task ssr:check:site` (it builds first).
 *
 * Why this exists: `typecheck` proves the types line up and `build` proves the bundle links,
 * but neither renders a page. A component that throws on the server, a route that 500s, or a
 * copy rule that only breaks once the strings are interpolated all pass both and still ship a
 * broken page. This calls the request handler directly — no port, no dev server, no waiting.
 */
import { createRequestHandler } from "react-router";
// Explicit .ts extension: this script runs under `node` (type-stripping), not bun, so it does
// not do extensionless resolution the way `copy-check.ts` can.
import { INDEXABLE_ROUTES } from "../app/lib/marketing/site-routes.ts";

const BUILD = "../build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/index.js";

/**
 * What must appear in each indexable page's HTML, keyed by path.
 *
 * The route SET is not listed here — it comes from `INDEXABLE_ROUTES` (site-routes.ts), the
 * same list `/sitemap.xml` is built from. This file used to keep its own copy, which meant a
 * new page could be added, shipped, and sitemapped while silently never being SSR-rendered by
 * anything. One list, three consumers (PILLAR3).
 *
 * The assertion strings stay hand-written because a good one is a judgement call: it should be
 * a string that only appears if the page's *data* actually reached the renderer, not just any
 * word from the layout. Every indexable route must have one — a missing entry is a failure
 * below, not a skip, so adding a page forces you to say how you'd know it rendered.
 */
const EXPECTED: Record<string, string> = {
  "/": "ColdStorage",
  "/how-it-works": "How deep storage works",
  "/pricing": "25 GB",
  "/compare": "Which one you actually want",
  "/faq": "Fair to ask",
  "/about": "Why we built it",
  "/source": "Functional Source License",
  // Expects a swatch hex: it renders only if the palette constants reached the page, which is
  // the one thing /brand must never get wrong.
  "/brand": "#C1E4FB",
  "/help": "Help center",
  "/contact": "Send message",
  "/download": "Download ColdStorage",
  "/privacy": "Privacy",
  "/terms": "Terms",
  "/refunds": "Refund",
};

const ROUTES: { path: string; expect: string }[] = INDEXABLE_ROUTES.map(({ path }) => {
  const expect = EXPECTED[path];
  if (!expect) {
    // Thrown rather than collected: without an assertion string there is nothing to check, so
    // continuing would report a pass for a page nobody verified.
    throw new Error(
      `ssr-check: ${path} is in INDEXABLE_ROUTES but has no EXPECTED[] string. Add one — a ` +
        `substring that appears ONLY if that page's content actually rendered.`
    );
  }
  return { path, expect };
});

/**
 * Rules asserted against RENDERED HTML rather than against the copy objects. `copy-check.ts`
 * scans the strings; these two are about what a reader actually receives, which is why
 * site/SPEC.md scopes them here.
 */
const HTML_RULES: { path: string; rule: string; forbid: RegExp }[] = [
  // The provider is never named in customer copy. Checked on the pages most likely to slip.
  ...["/", "/how-it-works", "/about", "/source", "/help", "/faq", "/brand"].map((path) => ({
    path,
    rule: "never-name-the-provider",
    forbid: /\b(aws|amazon s3|glacier|deep archive)\b/i,
  })),
  // /how-it-works stays free of dollar figures — the numbers live on /pricing.
  { path: "/how-it-works", rule: "no-dollar-figures-on-how-it-works", forbid: /\$\d/ },
];

/**
 * Every page carries exactly one `<h1>`, and on the non-landing pages that `<h1>` is the shared
 * `<PageHero>`.
 *
 * This is a real regression guard, not ceremony: before the page-hero port, `/faq`, `/pricing`
 * and `/download` each opened on an `<h2>` and shipped **no `<h1>` at all** — invisible in a
 * typecheck, invisible in a build, and visible to every screen reader and crawler. The
 * "exactly one" half matters just as much in the other direction: each of those pages now
 * renders a hero above a section that used to introduce itself, so a section whose own head is
 * left switched on would silently print the same words twice.
 */
const H1 = /<h1\b/g;
const H1_TEXT = /<h1[^>]*>([\s\S]*?)<\/h1>/;
const H2_TEXTS = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
const PAGE_HERO_H1 = /<h1[^>]*class="[^"]*cs-page-hero__title/;
const LANDING = "/";

const failures: string[] = [];

const build = await import(BUILD);
const handler = createRequestHandler(build, "production");

const html = new Map<string, string>();

for (const { path, expect } of ROUTES) {
  const res = await handler(new Request(`https://coldstorage.sh${path}`));
  const body = await res.text();
  html.set(path, body);

  if (res.status !== 200) {
    failures.push(`${path} returned ${res.status}, not 200`);
    continue;
  }
  if (!body.includes(expect)) {
    failures.push(`${path} rendered without "${expect}"`);
  }
}

for (const { path, rule, forbid } of HTML_RULES) {
  const body = html.get(path);
  if (!body) continue; // the route already failed above; don't pile on
  const hit = body.match(forbid);
  if (hit) failures.push(`${rule}: ${path} renders "${hit[0]}"`);
}

/*
 * The wordmark is lowercase `coldstorage`; the product name in prose is `ColdStorage` (Ben,
 * 2026-07-20). The <Wordmark> component makes the wrong casing unspellable — it takes no
 * children — but nothing stops someone dropping a plain <span> back into the nav. This asserts
 * the rendered logotype on every page, which is the thing a reader actually sees.
 */
for (const [path, body] of html) {
  const marks = [...body.matchAll(/<span class="csf-wordmark[^"]*">([^<]*)<\/span>/g)];
  if (marks.length === 0) {
    failures.push(`wordmark-is-lowercase: ${path} renders no <Wordmark> (nav + footer expected)`);
    continue;
  }
  const wrong = marks.find((m) => m[1] !== "coldstorage");
  if (wrong) {
    failures.push(`wordmark-is-lowercase: ${path} renders the wordmark as "${wrong[1]}"`);
  }
}

for (const { path } of ROUTES) {
  const body = html.get(path);
  if (!body) continue;

  const count = body.match(H1)?.length ?? 0;
  if (count !== 1) {
    failures.push(`one-h1-per-page: ${path} renders ${count} <h1> elements, expected exactly 1`);
    continue;
  }
  // The legal pages are the deliberate exception — long-form documents with their own head
  // treatment and their own copy SSOT (`legal.ts`), not marketing pages wearing the hero.
  const isLegal = ["/privacy", "/terms", "/refunds"].includes(path);
  if (path !== LANDING && !isLegal && !PAGE_HERO_H1.test(body)) {
    failures.push(`page-hero-is-the-page-head: ${path}'s <h1> is not the shared PageHero`);
  }

  // …and no section below repeats it. This is the failure mode of adding a hero to a page whose
  // section already introduced itself: both heads render, the words appear twice, and every
  // other check still passes because an <h2> is perfectly valid HTML.
  const title = body.match(H1_TEXT)?.[1];
  if (title && [...body.matchAll(H2_TEXTS)].some((m) => m[1] === title)) {
    failures.push(`no-repeated-page-title: ${path} renders "${title}" as both <h1> and <h2>`);
  }
}

/*
 * The `/contact` action, exercised for real.
 *
 * Invoked through the built route module rather than over HTTP: a document POST to the route
 * renders the page back as HTML, and the fetcher's `.data` endpoint speaks turbo-stream. The
 * action is the thing under test, so it's called directly — the same compiled code the server
 * runs, minus a transport that would only make the assertion harder to read.
 *
 * No mail is sent and none can be: with `CD2_API_KEY` unset the mailer refuses and reports
 * "failed", which is the branch worth pinning — it proves the whole chain (form parse →
 * Turnstile → zod → mailer) is wired and returns the typed result the form switches on. With a
 * key present the last case would really send, so it's skipped rather than quietly neutered.
 */
type ContactResultish = { status: string; fields?: string[] };
type ContactAction = (args: { request: Request }) => Promise<ContactResultish>;

const contactAction = build.routes["routes/($lang).contact"]?.module?.action as
  | ContactAction
  | undefined;

async function postContact(action: ContactAction, fields: Record<string, string>) {
  return action({
    request: new Request("https://coldstorage.sh/contact", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  });
}

if (!contactAction) {
  failures.push("/contact has no action export in the server build");
} else {
  const badInput = await postContact(contactAction, { name: "", email: "nope", message: "" });
  if (badInput.status !== "invalid") {
    failures.push(`/contact action: empty submission returned "${badInput.status}", want "invalid"`);
  } else if (!["name", "email", "message"].every((f) => badInput.fields?.includes(f))) {
    const got = JSON.stringify(badInput.fields);
    failures.push(`/contact action: empty submission flagged ${got}, want all three fields`);
  }

  if (process.env.CD2_API_KEY) {
    console.log("  (skipped the valid-submission case — CD2_API_KEY is set and it would send)");
  } else {
    const good = await postContact(contactAction, {
      name: "SSR Check",
      email: "ssr-check@example.com",
      message: "Exercising the contact action.",
    });
    if (good.status !== "failed") {
      failures.push(
        `/contact action: valid submission with no CD2 key returned "${good.status}", want "failed"`
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\n✗ SSR check failed — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}

console.log(
  `✓ SSR check passed — ${ROUTES.length} routes rendered, ${HTML_RULES.length} HTML rules + 3 page-head rules held`
);
