/**
 * Live catalog fetch + cache (PADDLE.md "Multi-plan picker"). Pulls active products/prices from
 * Paddle, maps them via the pure `mapCatalog`, and holds the result in module memory with a short
 * TTL — Fluid Compute reuses instances, so most requests never touch the Paddle API. Both readers
 * share this one cache: `GET /catalog` (what the app renders) and `POST /checkout-session` (which
 * validates a client-sent priceId against it — never trust the client to name its own price).
 */
import { paddle } from "./paddle.server.js";
import { mapCatalog, type CatalogEntry, type CatalogPrice, type CatalogProduct } from "./catalog.js";

const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; entries: CatalogEntry[] } | null = null;

/** The current sellable catalog (cached). Throws if Paddle is unreachable or the catalog is empty. */
export async function getCatalog(): Promise<CatalogEntry[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.entries;

  // No list filters — mirror the seed script's proven pattern (fetch all, filter in the mapper).
  const products: CatalogProduct[] = [];
  for await (const p of paddle.products.list()) products.push({ id: p.id, name: p.name, status: p.status });
  const prices: CatalogPrice[] = [];
  for await (const pr of paddle.prices.list()) {
    prices.push({
      id: pr.id,
      productId: pr.productId,
      status: pr.status,
      unitPrice: { amount: pr.unitPrice.amount, currencyCode: pr.unitPrice.currencyCode },
      billingCycle: pr.billingCycle ? { interval: pr.billingCycle.interval, frequency: pr.billingCycle.frequency } : null,
    });
  }

  const entries = mapCatalog(products, prices);
  if (entries.length === 0) throw new Error("Paddle returned an empty plan catalog — is the account seeded?");
  cache = { at: Date.now(), entries };
  return entries;
}
