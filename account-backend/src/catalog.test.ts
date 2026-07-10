import { describe, expect, test } from "bun:test";
import { mapCatalog, type CatalogPrice, type CatalogProduct } from "./catalog.js";

/** Fixtures shaped like what `scripts/seed-paddle-catalog.ts` writes. */
const product = (id: string, name: string, status = "active"): CatalogProduct => ({ id, name, status });
const price = (
  id: string,
  productId: string,
  amount: number,
  years: number | null,
  overrides: Partial<CatalogPrice> = {},
): CatalogPrice => ({
  id,
  productId,
  status: "active",
  unitPrice: { amount: String(amount), currencyCode: "USD" },
  billingCycle: years === null ? null : { interval: "year", frequency: years },
  ...overrides,
});

const SEEDED_PRODUCTS = [
  product("pro_500", "ColdStorage — 500 GB"),
  product("pro_1tb", "ColdStorage — 1 TB"),
  product("pro_2tb", "ColdStorage — 2 TB"),
];

describe("mapCatalog", () => {
  test("maps the seeded 3×4 catalog: sizes from product names, years from billing cycles, sorted cheapest-size then shortest-term", () => {
    // Deliberately shuffled input — order must come from the sort, not from Paddle.
    const prices = [
      price("pri_1tb_5", "pro_1tb", 9495, 5),
      price("pri_500_1", "pro_500", 999, 1),
      price("pri_2tb_1", "pro_2tb", 3699, 1),
      price("pri_500_3", "pro_500", 2997, 3),
      price("pri_1tb_1", "pro_1tb", 1899, 1),
    ];
    const catalog = mapCatalog(SEEDED_PRODUCTS, prices);

    expect(catalog.map((e) => e.priceId)).toEqual(["pri_500_1", "pri_500_3", "pri_1tb_1", "pri_1tb_5", "pri_2tb_1"]);
    expect(catalog[0]).toEqual({ size: "500 GB", years: 1, priceId: "pri_500_1", amountCents: 999, perMonthCents: 83 });
    // Rate-lock model: a 5-year term is exactly 5× yearly, so per-month equals the 1-year rate's.
    expect(catalog[3]).toEqual({ size: "1 TB", years: 5, priceId: "pri_1tb_5", amountCents: 9495, perMonthCents: 158 });
  });

  test("excludes everything off-SSOT: foreign products, archived entities, one-time/monthly/non-USD prices", () => {
    const products = [...SEEDED_PRODUCTS, product("pro_other", "Some Other App"), product("pro_dead", "ColdStorage — 4 TB", "archived")];
    const prices = [
      price("pri_ok", "pro_500", 999, 1),
      price("pri_foreign", "pro_other", 999, 1), // product outside the naming pattern
      price("pri_dead_product", "pro_dead", 999, 1), // archived product
      price("pri_archived", "pro_500", 999, 1, { status: "archived" }),
      price("pri_one_time", "pro_500", 999, null), // no billing cycle
      price("pri_monthly", "pro_500", 99, 1, { billingCycle: { interval: "month", frequency: 1 } }),
      price("pri_eur", "pro_500", 999, 1, { unitPrice: { amount: "999", currencyCode: "EUR" } }),
      price("pri_bogus_amount", "pro_500", 999, 2, { unitPrice: { amount: "9.99", currencyCode: "USD" } }),
    ];

    expect(mapCatalog(products, prices).map((e) => e.priceId)).toEqual(["pri_ok"]);
  });

  test("returns empty for an unseeded account", () => {
    expect(mapCatalog([], [])).toEqual([]);
  });
});
