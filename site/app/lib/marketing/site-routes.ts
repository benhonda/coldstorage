/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE INDEXABLE-ROUTE SSOT. What search engines and AI crawlers are told exists.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `/sitemap.xml` is generated from this list, and `task copy:check:site` cross-checks it
 * against the actual `app/routes/` tree — so a new page that nobody added here fails the
 * build instead of silently never being indexed. That guard is the reason this can be a
 * hand-written list at all (PILLAR3: hand-maintenance is fine when something mechanical
 * refuses to let it drift).
 *
 * WHAT BELONGS HERE: every page we want retrieved, ranked, and cited.
 * WHAT DOES NOT:
 *  - `/checkout` — a Paddle overlay host, already `noindex`. Indexing it would put a payment
 *    page in front of people who arrived from a search result with no context.
 *  - `download.dmg` — a redirect, not a page.
 *
 * Ordering is deliberate: `priority` is a relative hint, not a ranking lever. The pages that
 * answer a question in full (`/how-it-works`, `/pricing`, `/faq`, `/compare`) sit at the top
 * because those are the ones worth citing; legal pages sit at the bottom because they exist
 * to be correct, not found.
 */

/** How often a page's content realistically changes. Feeds `<changefreq>`. */
export type ChangeFreq = "daily" | "weekly" | "monthly" | "yearly";

export type IndexableRoute = {
  /** Path without a language prefix, always leading-slash. `/` is the home page. */
  path: string;
  /**
   * Relative importance within this site only (0.0–1.0). Search engines treat it as a weak
   * hint about which of OUR pages matter most — it says nothing about ranking against anyone
   * else, so there's no value in inflating it.
   */
  priority: number;
  changefreq: ChangeFreq;
};

/**
 * Every indexable page, highest-value first.
 *
 * The four at the top are the ones built to be *extracted*: they answer a whole question on
 * one URL (how deep storage works, what it costs, the common questions, how it compares), which
 * is what makes a page citable by an answer engine rather than merely crawlable.
 */
export const INDEXABLE_ROUTES: readonly IndexableRoute[] = [
  { path: "/", priority: 1.0, changefreq: "weekly" },
  { path: "/how-it-works", priority: 0.9, changefreq: "monthly" },
  { path: "/pricing", priority: 0.9, changefreq: "monthly" },
  { path: "/compare", priority: 0.9, changefreq: "monthly" },
  { path: "/faq", priority: 0.8, changefreq: "monthly" },
  { path: "/download", priority: 0.8, changefreq: "weekly" },
  { path: "/about", priority: 0.6, changefreq: "yearly" },
  { path: "/source", priority: 0.6, changefreq: "monthly" },
  { path: "/help", priority: 0.6, changefreq: "monthly" },
  { path: "/contact", priority: 0.5, changefreq: "yearly" },
  { path: "/brand", priority: 0.3, changefreq: "yearly" },
  { path: "/privacy", priority: 0.3, changefreq: "yearly" },
  { path: "/terms", priority: 0.3, changefreq: "yearly" },
  { path: "/refunds", priority: 0.3, changefreq: "yearly" },
] as const;

/**
 * Routes that exist but must stay out of the sitemap, with the reason. The guard reads this
 * so an intentional omission and a forgotten page look different to it — without this, the
 * only way to keep `/checkout` out would be to weaken the check that catches real mistakes.
 */
export const NON_INDEXABLE_ROUTES: Readonly<Record<string, string>> = {
  "/checkout": "Paddle overlay host — noindex; a payment page is not a landing page.",
  "/download.dmg": "Resource route (302 to the current release asset), not a page.",
};

/** The canonical production origin. Every absolute URL we emit is built from this one value. */
export const SITE_ORIGIN = "https://coldstorage.sh";

/** Absolute URL for a site-relative path, e.g. `/pricing` → `https://coldstorage.sh/pricing`. */
export function absoluteUrl(path: string): string {
  return path === "/" ? SITE_ORIGIN : `${SITE_ORIGIN}${path}`;
}
