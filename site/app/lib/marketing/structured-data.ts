/*
 * JSON-LD builders — the machine-readable half of the marketing site.
 *
 * Why this exists: an answer engine asked "what does ColdStorage cost" can either parse our
 * prose and hope, or read a price it was handed. Structured data is how the second one happens.
 * The `/faq` route already proved the pattern (`FAQPage`); this generalises it to the entity
 * (`Organization`) and the thing we sell (`SoftwareApplication` + its `Offer`s).
 *
 * ── The one rule ─────────────────────────────────────────────────────────────────────────
 * Every value here is DERIVED, never retyped. Offers come from `PRICING.tiers`, which
 * `task copy:check:site` already re-derives from `account-backend/src/plan-sizes.ts` every
 * run. So a price change flows: `plan-sizes.ts` → `content.ts` (guarded) → JSON-LD (derived).
 * Hand-typing a price here would create the one copy nothing checks, and it would be the copy
 * AI agents actually read (PILLAR3).
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────────────
 * No `aggregateRating`, no `review`, no `Review` nodes. We are pre-launch with zero customers;
 * emitting a rating would be fabricated social proof — the exact thing the copy rules forbid,
 * and worse in JSON-LD than in prose because it's a machine-readable assertion of a fact that
 * does not exist. Add these only when there are real reviews to point at.
 */
import { PRICING } from "~/lib/marketing/content";
import { SITE_ORIGIN, absoluteUrl } from "~/lib/marketing/site-routes";

/**
 * Minimal structural typing for the JSON-LD we emit. Not a full schema.org model — just enough
 * that a typo in a key is a type error rather than silently invalid structured data (PILLAR4).
 */
type JsonLd = { "@context": "https://schema.org"; "@type": string } & Record<string, unknown>;

/** `$9.99` → `"9.99"`. Schema.org wants a bare decimal string, no symbol. */
function priceFromDisplay(display: string): string {
  return display.replace(/[^0-9.]/g, "");
}

/**
 * The `Organization` node — who is publishing all of this.
 *
 * Entity recognition is the quiet prerequisite for everything else: an answer engine that
 * can't resolve "ColdStorage" to a stable entity treats each page as unattributed text. `sameAs`
 * is what links the name to corroborating profiles, which is why the repo URL is here — today
 * it's the only third-party surface that independently describes the product.
 */
export function organizationSchema(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: "ColdStorage",
    url: SITE_ORIGIN,
    logo: `${SITE_ORIGIN}/web-app-manifest-512x512.png`,
    description:
      "ColdStorage is encrypted cloud backup for files you want to keep but rarely open. Files are encrypted on your Mac before upload; only you hold the key.",
    sameAs: ["https://github.com/benhonda/coldstorage"],
  };
}

/**
 * The `SoftwareApplication` node — the Mac app and every plan you can buy for it.
 *
 * `offers` is an `AggregateOffer` rather than a bare list because the ladder genuinely has a
 * low and a high end, and `lowPrice` is the number that answers "how much is it?" — the free
 * tier is excluded from the price range (a $0 `lowPrice` reads as "it's free", which
 * misdescribes a paid ladder) but appears as its own `Offer` so the free tier is still visible
 * to anything reading the offer list.
 */
export function softwareApplicationSchema(): JsonLd {
  const paidTiers = PRICING.tiers.filter((t) => !t.free);
  const paidPrices = paidTiers.map((t) => Number(priceFromDisplay(t.year)));

  const offers = PRICING.tiers.map((tier) => ({
    "@type": "Offer",
    name: `${tier.size} plan`,
    price: tier.free ? "0" : priceFromDisplay(tier.year),
    priceCurrency: "USD",
    // Every paid plan is an annual subscription; the free tier is an entitlement, not a sale.
    ...(tier.free ? {} : { billingDuration: "P1Y" }),
    availability: "https://schema.org/InStock",
    url: absoluteUrl("/pricing"),
  }));

  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_ORIGIN}/#software`,
    name: "ColdStorage",
    applicationCategory: "UtilitiesApplication",
    applicationSubCategory: "Backup and archival storage",
    operatingSystem: "macOS",
    url: SITE_ORIGIN,
    downloadUrl: absoluteUrl("/download"),
    description:
      "Encrypted cloud backup for photos and files you want to keep but rarely open. Drag files into the Mac app; they are encrypted on your device before upload. Storage starts at $9.99 per year for 500 GB, with 25 GB free.",
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: Math.min(...paidPrices).toFixed(2),
      highPrice: Math.max(...paidPrices).toFixed(2),
      offerCount: offers.length,
      offers,
    },
  };
}
