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
