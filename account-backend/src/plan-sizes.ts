/**
 * Plan-size SSOT (PROD.md "Storage quota enforcement"). One canonical list mapping each sellable
 * storage size to its display label, byte quota, and yearly price — imported by both
 * `scripts/seed-paddle-catalog.ts` (writes the Paddle catalog) and `catalog.ts` (maps it back),
 * so the size labels and their byte counts can never drift apart.
 *
 * Prices are generator-derived (SPEC.md §5): `perYearCents = round(1.8 * bytes/1e9 + 99)`, i.e.
 * $0.018/GB/yr + a $0.99 fixed per-account component. Never hand-type a new row's price — derive
 * it from that formula so the ladder can't drift off its own pricing logic.
 */
export const PLAN_SIZES = [
  { size: "500 GB", bytes: 500_000_000_000, perYearCents: 999 },
  { size: "1 TB", bytes: 1_000_000_000_000, perYearCents: 1899 },
  { size: "2 TB", bytes: 2_000_000_000_000, perYearCents: 3699 },
  { size: "5 TB", bytes: 5_000_000_000_000, perYearCents: 9099 },
  { size: "10 TB", bytes: 10_000_000_000_000, perYearCents: 18099 },
] as const;

/**
 * The free tier (PROD.md, DECIDED 2026-07-12): 25 GB, every account, forever — no trial.
 *
 * It lives in this SSOT beside the paid sizes because it IS a quota like any other, and `GET /entitlement`
 * hands it out as `quotaBytes` whenever there's no active subscription — which makes the byte quota the
 * single deposit gate for every signed-in account, free or paid. But it is deliberately NOT a row in
 * `PLAN_SIZES`: it must never be seeded as a Paddle product, never appear in the plan picker, and never
 * carry a price. It is an entitlement, not something we sell.
 *
 * "Forever" is a promise, so this number can only ever move UP. Deliberately started small (still above
 * Google's 15 GB); a maxed free account costs ~$0.30/yr on Deep Archive.
 */
/* ⚠️⚠️ TEMPORARY — 2026-07-13, Ben: shrunk to 1 GB to test the cap-reached gate + restore in one sitting.
 *      THE REAL VALUE IS 25_000_000_000 (25 GB). REVERT THIS LINE BEFORE MERGING TO main. ⚠️⚠️ */
export const FREE_TIER_BYTES = 1_000_000_000;

/**
 * The free tier a given deployment actually hands out — `FREE_TIER_BYTES` unless a NON-PRODUCTION
 * deployment overrides it (`FREE_TIER_BYTES_OVERRIDE`, e.g. 1_000_000_000 to fill a test vault in one
 * upload and exercise the cap-reached gate without shipping 25 GB at it).
 *
 * **The override is ignored in production, by construction.** It is gated on `PADDLE_ENVIRONMENT`, the
 * same var that decides whether money is real — so a stray env var, a copied Vercel project, or a
 * merged test branch cannot quietly shrink the free tier under real customers. "25 GB forever" is a
 * promise, and a promise that a config value can silently break is not one. A production deployment
 * that *tries* to set it gets the real number and a loud warning, not the override.
 */
export function resolveFreeTierBytes(
  override: number | undefined,
  paddleEnvironment: "sandbox" | "production",
): number {
  if (override === undefined) return FREE_TIER_BYTES;
  if (paddleEnvironment === "production") {
    console.warn(
      `FREE_TIER_BYTES_OVERRIDE (${override}) IGNORED — this is a production deployment; free tier stays ${FREE_TIER_BYTES}.`,
    );
    return FREE_TIER_BYTES;
  }
  return override;
}

/**
 * The Paddle PRODUCT that retrieval charges hang off (root `RETRIEVAL.md`). It deliberately carries NO
 * catalog prices — every restore is billed as a non-catalog (inline) price for its own exact amount,
 * because a restore's cost is a function of its bytes and can't be enumerated in advance. The product
 * exists only to give those inline prices something real to belong to (Paddle requires it, and it keeps
 * retrieval revenue legible in Paddle's own reporting).
 *
 * It lives in this SSOT — not as a bare string in the seed script — because THREE places must agree on
 * it, and a drift between them fails in a different, confusing way each time:
 *   - `scripts/seed-paddle-catalog.ts` creates it, and must NOT archive it as an off-SSOT stray.
 *   - `catalog.ts` must EXCLUDE it from the plan mapping (it matches the `ColdStorage — <x>` pattern,
 *     but "Data retrieval" is not a storage size and has no byte quota).
 *   - `retrieval.server.ts` resolves its id at runtime, by this exact name, to bill against it.
 */
export const RETRIEVAL_PRODUCT_NAME = "ColdStorage — Data retrieval";
