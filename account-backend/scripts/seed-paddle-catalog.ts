/**
 * Seed the ColdStorage product catalog in Paddle — 5 products (storage sizes), one annual
 * recurring price each = 5 prices total. No terms — annual only (SPEC.md §5, decided 2026-07-12
 * / site/app/lib/marketing/content.ts is the pricing SSOT this mirrors).
 *
 * SAFE BY DEFAULT: with no `--apply` flag it PLANS only (reads the account, prints what it
 * would create) and writes nothing. Pass `--apply` to actually create. Idempotent — matches
 * existing products by name and existing prices by (product, interval, frequency), so a
 * re-run (e.g. sandbox first, then production, or after a partial failure) never duplicates.
 * Paddle entities can't be hard-deleted, so idempotency is the whole point.
 *
 * `--archive-extras` additionally ARCHIVES active entities outside the SSOT — products whose
 * name isn't in the catalog, plus prices on kept products with an off-SSOT billing cycle.
 * Archiving only blocks NEW checkouts; existing subscriptions keep renewing. Plan-gated like
 * everything else: without `--apply` it just lists what it would archive.
 *
 * Run it via the Taskfile (loads no secrets itself — you supply the keys). `--env` picks which
 * account a run targets; the key's prefix is asserted against it, so a wrong-slot key fails loudly:
 *   export PADDLE_API_KEY='pdl_live_apikey_…'               # live
 *   export PADDLE_API_KEY_FOR_SANDBOX='pdl_sdbx_apikey_…'   # sandbox
 *   task backend:paddle:seed -- --env sandbox                            # PLAN (read-only)
 *   task backend:paddle:seed -- --env production --apply                 # WRITE to the LIVE account
 *   task backend:paddle:seed -- --env sandbox --archive-extras           # also PLAN the strays
 *   task backend:paddle:seed -- --env sandbox --apply --archive-extras   # converge fully
 *
 * Env:
 *   PADDLE_API_KEY             (for --env production) a live key with product + price write scope.
 *   PADDLE_API_KEY_FOR_SANDBOX (for --env sandbox) the sandbox equivalent.
 *   PADDLE_TAX_CATEGORY        (optional) default "saas" (must be approved in Catalog → Taxable
 *                              categories). Set "standard" to use the pre-approved default instead.
 */
import { type TaxCategory } from "@paddle/paddle-node-sdk";
import { paddleFromEnv } from "./_paddle.js";
import { PLAN_SIZES } from "../src/plan-sizes.js";

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
 * One annual price per size — no terms. Amounts are in cents (minor units). Sizes + prices come
 * from `../src/plan-sizes.js`, the SSOT shared with `catalog.ts`'s quota mapping — never
 * duplicate the size/price literals here. */
const PRODUCTS = PLAN_SIZES;

const CURRENCY = "USD";

const productName = (size: string) => `ColdStorage — ${size}`;
const productDescription = (size: string) =>
  `${size} of long-term cloud storage for your photos and files. Annual subscription that auto-renews until you cancel.`;
const priceDescription = (size: string) => `ColdStorage ${size} — annual`;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/* ── Config from env ──────────────────────────────────────────────────────────────────── */
const { paddle, envName, keyVar, keyMasked } = paddleFromEnv();
const taxCategoryRaw = process.env.PADDLE_TAX_CATEGORY ?? "saas";
const APPLY = process.argv.includes("--apply");
const ARCHIVE_EXTRAS = process.argv.includes("--archive-extras");

if (!isTaxCategory(taxCategoryRaw)) {
  console.error(`✗ PADDLE_TAX_CATEGORY "${taxCategoryRaw}" is not a valid Paddle tax category.\n  One of: ${TAX_CATEGORIES.join(", ")}`);
  process.exit(1);
}
const taxCategory: TaxCategory = taxCategoryRaw;

const ANNUAL = { interval: "year" as const, frequency: 1 };
const cycleKey = (interval: string, frequency: number) => `${interval}:${frequency}`;
const ANNUAL_CYCLE = cycleKey(ANNUAL.interval, ANNUAL.frequency);

async function main() {
  console.log("─".repeat(72));
  console.log(`ColdStorage → Paddle catalog seed`);
  // Show only the non-secret prefix so you can spot a wrong-key run instantly.
  console.log(`  key         : ${keyMasked}`);
  console.log(`  environment : ${envName}${envName === "production" ? "  ⚠️  LIVE ACCOUNT" : ""}  (--env, key prefix verified)`);
  console.log(`  tax category: ${taxCategory}`);
  console.log(`  mode        : ${APPLY ? "APPLY (writes)" : "PLAN (dry-run — no writes)"}${ARCHIVE_EXTRAS ? " + archive-extras" : ""}`);
  console.log("─".repeat(72));

  // Existing state (so we're idempotent).
  const existingProducts: { id: string; name: string; taxCategory: string; status: string }[] = [];
  for await (const p of paddle.products.list()) {
    existingProducts.push({ id: p.id, name: p.name, taxCategory: p.taxCategory, status: p.status });
  }
  const productByName = new Map(existingProducts.filter((p) => p.status === "active").map((p) => [p.name, p]));

  // All ACTIVE prices — for idempotent matching and for --archive-extras.
  const activePrices: { id: string; productId: string; name: string | null; amount: string; currency: string; cycle: string | null }[] = [];
  for await (const pr of paddle.prices.list()) {
    if (pr.status !== "active") continue;
    activePrices.push({
      id: pr.id,
      productId: pr.productId,
      name: pr.name ?? null,
      amount: pr.unitPrice.amount,
      currency: pr.unitPrice.currencyCode,
      cycle: pr.billingCycle ? cycleKey(pr.billingCycle.interval, pr.billingCycle.frequency) : null, // null = one-time
    });
  }

  // Map of productId -> set of "interval:frequency" for its active recurring prices.
  const pricesByProduct = new Map<string, Set<string>>();
  for (const pr of activePrices) {
    if (!pr.cycle) continue;
    const set = pricesByProduct.get(pr.productId) ?? new Set<string>();
    set.add(pr.cycle);
    pricesByProduct.set(pr.productId, set);
  }

  const created = { products: 0, prices: 0 };
  const skipped = { products: 0, prices: 0 };
  /** size → price id, for the final copy-paste block. */
  const priceIds: { size: string; amount: number; id: string | null }[] = [];

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
    const amount = perYearCents;

    if (existingCycles.has(ANNUAL_CYCLE)) {
      skipped.prices++;
      priceIds.push({ size, amount, id: "(exists)" });
      console.log(`    ● price exists  annual   ${usd(amount)}`);
    } else if (APPLY && productId.startsWith("pro_")) {
      const price = await paddle.prices.create({
        productId,
        name: "Annual",
        description: priceDescription(size),
        unitPrice: { amount: String(amount), currencyCode: CURRENCY },
        billingCycle: ANNUAL,
        // A customer buys ONE storage plan — cap quantity so nobody can order multiples.
        quantity: { minimum: 1, maximum: 1 },
        taxMode: "account_setting",
      });
      created.prices++;
      priceIds.push({ size, amount, id: price.id });
      console.log(`    ✓ price CREATED annual   ${usd(amount)}  (${price.id})`);
    } else {
      priceIds.push({ size, amount, id: null });
      console.log(`    + price PLAN    annual   ${usd(amount)}  every year, qty 1`);
    }
  }

  // ── --archive-extras: retire active entities outside the SSOT ─────────────────────────
  const archived = { products: 0, prices: 0 };
  if (ARCHIVE_EXTRAS) {
    const ssotNames = new Set(PRODUCTS.map((p) => productName(p.size)));
    const ssotCycles = new Set([ANNUAL_CYCLE]);
    const strayProducts = existingProducts.filter((p) => p.status === "active" && !ssotNames.has(p.name));
    const strayProductIds = new Set(strayProducts.map((p) => p.id));
    const keptProductIds = new Set(existingProducts.filter((p) => p.status === "active" && ssotNames.has(p.name)).map((p) => p.id));
    // A stray price hangs off a stray product, or sits on a kept product with an off-SSOT
    // billing cycle (incl. one-time prices).
    const strayPrices = activePrices.filter(
      (pr) => strayProductIds.has(pr.productId) || (keptProductIds.has(pr.productId) && (!pr.cycle || !ssotCycles.has(pr.cycle))),
    );

    console.log("─".repeat(72));
    if (strayProducts.length === 0 && strayPrices.length === 0) {
      console.log("archive-extras: nothing to archive — no active entities outside the SSOT.");
    }
    // Prices first, so no product is archived out from under a still-active price.
    for (const pr of strayPrices) {
      const label = `${(pr.name ?? "(unnamed)").padEnd(14)} ${pr.currency} ${(Number(pr.amount) / 100).toFixed(2)}  (${pr.id})`;
      if (APPLY) {
        await paddle.prices.update(pr.id, { status: "archived" });
        archived.prices++;
        console.log(`✓ price ARCHIVED   ${label}`);
      } else {
        console.log(`- price ARCHIVE    ${label}`);
      }
    }
    for (const p of strayProducts) {
      if (APPLY) {
        await paddle.products.update(p.id, { status: "archived" });
        archived.products++;
        console.log(`✓ product ARCHIVED ${p.name}  (${p.id})`);
      } else {
        console.log(`- product ARCHIVE  ${p.name}  (${p.id})`);
      }
    }
  }

  console.log("─".repeat(72));
  console.log(`products: ${created.products} created, ${skipped.products} already existed${ARCHIVE_EXTRAS ? `, ${archived.products} archived` : ""}`);
  console.log(`prices:   ${created.prices} created, ${skipped.prices} already existed${ARCHIVE_EXTRAS ? `, ${archived.prices} archived` : ""}`);

  if (APPLY) {
    console.log("\nPrice IDs (paste into the app plan-picker / Terraform paddle_price_id):");
    for (const r of priceIds) {
      const slug = r.size.replace(/\s+/g, "").toUpperCase();
      console.log(`  ${slug.padEnd(8)} ${usd(r.amount).padEnd(9)} ${r.id ?? "(exists — fetch from dashboard)"}`);
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
        `    export a full-access key instead:  export ${keyVar}='<key with product/price write>'`
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
