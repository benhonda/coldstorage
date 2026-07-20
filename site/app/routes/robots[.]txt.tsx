import { NON_INDEXABLE_ROUTES, SITE_ORIGIN } from "~/lib/marketing/site-routes";

/**
 * `/robots.txt` — resource route rather than a static `public/robots.txt`, so the disallow
 * list and the sitemap URL are built from `site-routes.ts` instead of being a second hand-kept
 * copy of it (PILLAR3).
 *
 * ── The distinction this file exists to get right ────────────────────────────────────────
 * AI crawlers are not one category, and treating them as one is the common mistake. There are
 * three, and they want different things (verified July 2026):
 *
 *  1. TRAINING crawlers — GPTBot, ClaudeBot, Google-Extended, anthropic-ai, CCBot,
 *     Applebot-Extended, Meta-ExternalAgent. These collect corpus for model training. Blocking
 *     them keeps the site out of future training sets.
 *  2. SEARCH / RETRIEVAL crawlers — OAI-SearchBot, Claude-SearchBot, PerplexityBot. These
 *     fetch pages to answer live queries **and are what produce citations.** Blocking these
 *     removes us from AI answers entirely.
 *  3. USER-INITIATED fetchers — ChatGPT-User, Claude-User. Triggered when a person explicitly
 *     asks an assistant to open our URL. Blocking these breaks a link someone deliberately shared.
 *
 * Blocking GPTBot (training) does NOT stop ChatGPT citing us — that's OAI-SearchBot's job. The
 * two get conflated constantly, and the mistake is expensive in the direction people don't
 * expect: they block the training bot for principle, keep the search bot, and are surprised
 * either way.
 *
 * ── Our stance: allow everything, named explicitly ───────────────────────────────────────
 * A pre-launch product nobody has heard of needs every discovery path there is, and training
 * inclusion is how a brand ends up in a model's baseline knowledge rather than only in its
 * search results. This is public marketing copy written to be read.
 *
 * Note this has nothing to do with the product's no-AI-scanning commitment — that is about
 * customer files, which never leave deep storage unencrypted and are not on this domain. Do
 * not "consistency-fix" this file toward blocking on privacy grounds; it would cost real
 * discovery to make a point the privacy promise never made.
 *
 * The allowlist is written out by name rather than relying on the bare `User-agent: *` default
 * so the intent is on the record — the failure mode here is someone later adding a blanket
 * block "for safety" and quietly deleting the site from AI answers.
 */

/** Every AI agent we explicitly welcome, grouped by what it actually does. */
const AI_AGENTS = {
  training: [
    "GPTBot",
    "ClaudeBot",
    "anthropic-ai",
    "Google-Extended",
    "Applebot-Extended",
    "Meta-ExternalAgent",
    "CCBot",
  ],
  search: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"],
  userInitiated: ["ChatGPT-User", "Claude-User"],
} as const;

export function loader() {
  const disallows = Object.keys(NON_INDEXABLE_ROUTES)
    .map((path) => `Disallow: ${path}`)
    .join("\n");

  const agentBlock = (agents: readonly string[]) =>
    agents.map((ua) => `User-agent: ${ua}\nAllow: /\n${disallows}`).join("\n\n");

  const body = [
    "# ColdStorage — https://coldstorage.sh",
    "# Everything here is public marketing copy. Crawl it.",
    "",
    "User-agent: *",
    "Allow: /",
    disallows,
    "",
    "# AI training crawlers — allowed.",
    agentBlock(AI_AGENTS.training),
    "",
    "# AI search crawlers — allowed. These are the ones that produce citations.",
    agentBlock(AI_AGENTS.search),
    "",
    "# User-initiated fetchers — allowed. Someone asked an assistant to open our page.",
    agentBlock(AI_AGENTS.userInitiated),
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
