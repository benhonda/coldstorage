/**
 * Seed the ColdStorage product catalog in Paddle — 3 products (storage sizes) × 4 prices
 * (1/2/3/5-year terms) = 12 recurring prices, at the settled no-multi-year-discount pricing
 * (SPEC §5 / site/app/lib/marketing/content.ts is the pricing SSOT this mirrors).
 *
 * SAFE BY DEFAULT: with no `--apply` flag it PLANS only (reads the account, prints what it
 * would create) and writes nothing. Pass `--apply` to actually create. Idempotent — matches
 * existing products by name and existing prices by (product, interval, frequency), so a
 * re-run (e.g. sandbox first, then production, or after a partial failure) never duplicates.
 * Paddle entities can't be hard-deleted, so idempotency is the whole point.
 *
 * Run it via the Taskfile (loads no secrets itself — you supply the key):
 *   export PADDLE_API_KEY='pdl_live_apikey_…'   # or a pdl_sdbx_… sandbox key
 *   task backend:paddle:seed              # PLAN (read-only)
 *   task backend:paddle:seed -- --apply   # WRITE
 *
 * Env:
 *   PADDLE_API_KEY        (required) a Paddle API key with product + price write scope. The
 *                         environment (sandbox vs production) is auto-detected from its prefix.
 *   PADDLE_TAX_CATEGORY   (optional) default "saas" (must be approved in Catalog → Taxable
 *                         categories). Set "standard" to use the pre-approved default instead.
 */
import { type TaxCategory } from "@paddle/paddle-node-sdk";
import { paddleFromEnv } from "./_paddle.js";

/** The full Paddle tax-category union, as a runtime list so we can validate env input. */
const TAX_CATEGORIES: readonly TaxCategory[] = [
  "digital-goods",
  "ebooks",
  "implementation-services",
  "professional-services",
  "saas",
  "software-programming-services",
  "standard",
  "training-services",
  "website-hosting",
];
const isTaxCategory = (v: string): v is TaxCategory => (TAX_CATEGORIES as readonly string[]).includes(v);

/* ── Pricing SSOT (mirrors site/app/lib/marketing/content.ts) ─────────────────────────────
 * A term is EXACTLY N × the yearly rate — the rate-lock model has no multi-year discount, so
 * every multi-year amount is derived, never hand-typed. Amounts are in cents (minor units). */
const PRODUCTS = [
  { size: "500 GB", perYearCents: 999 },
  { size: "1 TB", perYearCents: 1899 },
  { size: "2 TB", perYearCents: 3699 },
] as const;

const TERMS = [
  { years: 1, label: "1 year" },
  { years: 2, label: "2 years" },
  { years: 3, label: "3 years" },
  { years: 5, label: "5 years" },
] as const;

const CURRENCY = "USD";

const productName = (size: string) => `ColdStorage — ${size}`;
const productDescription = (size: string) =>
  `${size} of long-term cloud storage for your photos and files. Prepaid subscription that renews until you cancel.`;
const priceDescription = (size: string, label: string) => `ColdStorage ${size} — ${label} term`;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/* ── Config from env ──────────────────────────────────────────────────────────────────── */
const { paddle, envName, keyMasked } = paddleFromEnv();
const taxCategoryRaw = process.env.PADDLE_TAX_CATEGORY ?? "saas";
const APPLY = process.argv.includes("--apply");

if (!isTaxCategory(taxCategoryRaw)) {
  console.error(`✗ PADDLE_TAX_CATEGORY "${taxCategoryRaw}" is not a valid Paddle tax category.\n  One of: ${TAX_CATEGORIES.join(", ")}`);
  process.exit(1);
}
const taxCategory: TaxCategory = taxCategoryRaw;

const bill = (years: number) => ({ interval: "year" as const, frequency: years });
const cycleKey = (interval: string, frequency: number) => `${interval}:${frequency}`;

async function main() {
  console.log("─".repeat(72));
  console.log(`ColdStorage → Paddle catalog seed`);
  // Show only the non-secret prefix so you can spot a wrong-key run instantly.
  console.log(`  key         : ${keyMasked}`);
  console.log(`  environment : ${envName}${envName === "production" ? "  ⚠️  LIVE ACCOUNT" : ""}  (from key prefix)`);
  console.log(`  tax category: ${taxCategory}`);
  console.log(`  mode        : ${APPLY ? "APPLY (writes)" : "PLAN (dry-run — no writes)"}`);
  console.log("─".repeat(72));

  // Existing state (so we're idempotent).
  const existingProducts: { id: string; name: string; taxCategory: string; status: string }[] = [];
  for await (const p of paddle.products.list()) {
    existingProducts.push({ id: p.id, name: p.name, taxCategory: p.taxCategory, status: p.status });
  }
  const productByName = new Map(existingProducts.filter((p) => p.status === "active").map((p) => [p.name, p]));

  // Map of productId -> set of "interval:frequency" for its active prices.
  const pricesByProduct = new Map<string, Set<string>>();
  for await (const pr of paddle.prices.list()) {
    if (pr.status !== "active" || !pr.billingCycle) continue;
    const set = pricesByProduct.get(pr.productId) ?? new Set<string>();
    set.add(cycleKey(pr.billingCycle.interval, pr.billingCycle.frequency));
    pricesByProduct.set(pr.productId, set);
  }

  const created = { products: 0, prices: 0 };
  const skipped = { products: 0, prices: 0 };
  /** size × term → price id, for the final copy-paste block. */
  const priceIds: { size: string; years: number; label: string; amount: number; id: string | null }[] = [];

  for (const { size, perYearCents } of PRODUCTS) {
    const name = productName(size);
    let productId: string;

    const existing = productByName.get(name);
    if (existing) {
      productId = existing.id;
      skipped.products++;
      const warn = existing.taxCategory !== taxCategory ? `  ⚠️  tax category is "${existing.taxCategory}", not "${taxCategory}"` : "";
      console.log(`● product exists  ${name}  (${productId})${warn}`);
    } else if (APPLY) {
      const p = await paddle.products.create({ name, description: productDescription(size), taxCategory });
      productId = p.id;
      created.products++;
      console.log(`✓ product CREATED ${name}  (${productId})`);
    } else {
      productId = "(would create)";
      console.log(`+ product PLAN    ${name}  [tax: ${taxCategory}]`);
    }

    const existingCycles = productId.startsWith("pro_") ? pricesByProduct.get(productId) ?? new Set<string>() : new Set<string>();

    for (const { years, label } of TERMS) {
      const amount = perYearCents * years;
      const key = cycleKey("year", years);

      if (existingCycles.has(key)) {
        skipped.prices++;
        priceIds.push({ size, years, label, amount, id: "(exists)" });
        console.log(`    ● price exists  ${label.padEnd(8)} ${usd(amount)}`);
        continue;
      }

      if (APPLY && productId.startsWith("pro_")) {
        const price = await paddle.prices.create({
          productId,
          name: label,
          description: priceDescription(size, label),
          unitPrice: { amount: String(amount), currencyCode: CURRENCY },
          billingCycle: bill(years),
          // A customer buys ONE storage plan — cap quantity so nobody can order multiples.
          quantity: { minimum: 1, maximum: 1 },
          taxMode: "account_setting",
        });
        created.prices++;
        priceIds.push({ size, years, label, amount, id: price.id });
        console.log(`    ✓ price CREATED ${label.padEnd(8)} ${usd(amount)}  (${price.id})`);
      } else {
        priceIds.push({ size, years, label, amount, id: null });
        console.log(`    + price PLAN    ${label.padEnd(8)} ${usd(amount)}  every ${years} year(s), qty 1`);
      }
    }
  }

  console.log("─".repeat(72));
  console.log(`products: ${created.products} created, ${skipped.products} already existed`);
  console.log(`prices:   ${created.prices} created, ${skipped.prices} already existed`);

  if (APPLY) {
    console.log("\nPrice IDs (paste into the app plan-picker / Terraform paddle_price_id):");
    for (const r of priceIds) {
      const slug = `${r.size.replace(/\s+/g, "").toUpperCase()}_${r.years}YR`;
      console.log(`  ${slug.padEnd(12)} ${usd(r.amount).padEnd(9)} ${r.id ?? "(exists — fetch from dashboard)"}`);
    }
  } else {
    console.log("\nThis was a PLAN. Re-run with `-- --apply` to create the catalog.");
  }
  console.log("─".repeat(72));
}

main().catch((e) => {
  const detail = String(e?.detail ?? e?.message ?? e);
  console.error("\n✗ Seed failed:", detail);
  if (/permitted|forbidden|permission/i.test(detail) || String(e?.code ?? "").includes("forbidden")) {
    console.error(
      `  → This API key authenticated but lacks catalog permissions.\n` +
        `    A plan needs READ, and --apply needs WRITE, on both Products and Prices.\n` +
        `    The key auto-loaded from account-backend/.env is the minimal-scope webhook key —\n` +
        `    export a full-access key instead:  export PADDLE_API_KEY='<key with product/price write>'`
    );
  }
  if (String(e?.code ?? "").includes("tax_category") || String(e?.detail ?? "").includes("tax category")) {
    console.error(
      `  → The "${taxCategory}" tax category isn't approved on this account yet.\n` +
        `    Approve it in Paddle → Catalog → Taxable categories, or re-run with\n` +
        `    PADDLE_TAX_CATEGORY=standard to use the default (approve/switch later).`
    );
  }
  process.exit(1);
});
