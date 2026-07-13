/**
 * Pure catalog mapping (PADDLE.md "Multi-plan picker") — turns raw Paddle products/prices into the
 * plan catalog the app renders. Pure + structurally typed so it unit-tests without the SDK; the live
 * fetch/cache lives in `catalog.server.ts`.
 *
 * The shape mirrors what `scripts/seed-paddle-catalog.ts` writes (the catalog SSOT): products named
 * `ColdStorage — <size>`, USD recurring prices billed every N years. Anything off-pattern (other
 * products, one-time prices, non-year cycles, non-USD) is excluded rather than guessed at — the
 * picker must never sell an entity the seed script didn't define.
 */
import { PLAN_SIZES } from "./plan-sizes.js";

/** One sellable plan: a size × term cell of the catalog. */
export interface CatalogEntry {
  /** Storage size label, e.g. "1 TB" (from the product name). */
  size: string;
  /** Byte quota for this size, from the `PLAN_SIZES` SSOT — e.g. "1 TB" → 1_000_000_000_000. */
  quotaBytes: number;
  /** Term length in years (the billing cycle — renews every N years). */
  years: number;
  priceId: string;
  /** Total for the whole term, in USD cents (what checkout charges). */
  amountCents: number;
  /** Derived per-month equivalent in cents (rounded) — display only. */
  perMonthCents: number;
}

/** Structural subsets of the Paddle SDK entities — just the fields the mapping reads. */
export interface CatalogProduct {
  id: string;
  name: string;
  status: string;
}
export interface CatalogPrice {
  id: string;
  productId: string;
  status: string;
  unitPrice: { amount: string; currencyCode: string };
  billingCycle: { interval: string; frequency: number } | null;
}

const PRODUCT_NAME_PATTERN = /^ColdStorage — (.+)$/;

const bytesForSize = new Map<string, number>(PLAN_SIZES.map((p) => [p.size, p.bytes]));

/** Map raw Paddle entities to the sorted plan catalog (cheapest size first, shortest term first).
 * Throws if an active product's size doesn't match `PLAN_SIZES` — an unrecognized size must fail
 * loud, never silently ship a plan with no enforceable byte quota. */
export function mapCatalog(products: CatalogProduct[], prices: CatalogPrice[]): CatalogEntry[] {
  const sizeByProductId = new Map<string, string>();
  for (const p of products) {
    const size = p.status === "active" ? PRODUCT_NAME_PATTERN.exec(p.name)?.[1] : undefined;
    if (size) sizeByProductId.set(p.id, size);
  }

  const entries: CatalogEntry[] = [];
  for (const pr of prices) {
    const size = sizeByProductId.get(pr.productId);
    if (!size || pr.status !== "active") continue;
    if (pr.billingCycle?.interval !== "year") continue; // one-time or non-year cycle — not a plan
    if (pr.unitPrice.currencyCode !== "USD") continue;
    const amountCents = Number(pr.unitPrice.amount);
    if (!Number.isInteger(amountCents) || amountCents <= 0) continue;
    const quotaBytes = bytesForSize.get(size);
    if (quotaBytes === undefined) {
      throw new Error(`Unrecognized plan size "${size}" — not in PLAN_SIZES. Refusing to sell an unquotad plan.`);
    }
    const years = pr.billingCycle.frequency;
    entries.push({
      size,
      quotaBytes,
      years,
      priceId: pr.id,
      amountCents,
      perMonthCents: Math.round(amountCents / (years * 12)),
    });
  }

  return entries.sort((a, b) => a.amountCents / a.years - b.amountCents / b.years || a.years - b.years);
}
