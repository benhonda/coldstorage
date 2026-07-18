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

const BUILD = "../build/server/nodejs_eyJydW50aW1lIjoibm9kZWpzIn0/index.js";

/** Routes to render, and a string that must appear in each one's HTML. */
const ROUTES: { path: string; expect: string }[] = [
  { path: "/", expect: "ColdStorage" },
  { path: "/how-it-works", expect: "How deep storage works" },
  { path: "/pricing", expect: "25 GB" },
  { path: "/faq", expect: "Fair to ask" },
  { path: "/about", expect: "Why we built it" },
  { path: "/source", expect: "Functional Source License" },
  { path: "/help", expect: "Help center" },
  { path: "/contact", expect: "Send message" },
  { path: "/privacy", expect: "Privacy" },
  { path: "/terms", expect: "Terms" },
  { path: "/refunds", expect: "Refund" },
];

/**
 * Rules asserted against RENDERED HTML rather than against the copy objects. `copy-check.ts`
 * scans the strings; these two are about what a reader actually receives, which is why
 * site/SPEC.md scopes them here.
 */
const HTML_RULES: { path: string; rule: string; forbid: RegExp }[] = [
  // The provider is never named in customer copy. Checked on the pages most likely to slip.
  ...["/", "/how-it-works", "/about", "/source", "/help", "/faq"].map((path) => ({
    path,
    rule: "never-name-the-provider",
    forbid: /\b(aws|amazon s3|glacier|deep archive)\b/i,
  })),
  // /how-it-works stays free of dollar figures — the numbers live on /pricing.
  { path: "/how-it-works", rule: "no-dollar-figures-on-how-it-works", forbid: /\$\d/ },
];

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
  `✓ SSR check passed — ${ROUTES.length} routes rendered, ${HTML_RULES.length} HTML rules held`
);
