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
