/**
 * SSOT invariants for the plan ladder + the free tier. These are cheap to assert and expensive to get
 * wrong: both failures below would ship silently and only surface in Paddle or in a user's face.
 */
import { describe, expect, test } from "bun:test";
import { FREE_TIER_BYTES, PLAN_SIZES, resolveFreeTierBytes } from "./plan-sizes.js";

describe("the free tier", () => {
  // "25 GB forever" is a published promise (the marketing hero says it), so the number is pinned
  // here rather than left to whatever the const happens to say. It can only ever move UP.
  // To test the cap-reached gate, use FREE_TIER_BYTES_OVERRIDE on a non-production deployment —
  // do not edit the const (that is what happened 2026-07-13, and it shipped to staging).
  test("is 25 GB", () => {
    expect(FREE_TIER_BYTES).toBe(25_000_000_000);
  });

  // `scripts/seed-paddle-catalog.ts` and the plan picker both iterate PLAN_SIZES. A 25 GB row added there
  // would seed the free tier as a real, priced Paddle product and put it in the picker — it is an
  // entitlement, not something we sell.
  // (`PLAN_SIZES` is `as const`, so its byte counts are literal types and `tsc` already rejects a direct
  //  `=== FREE_TIER_BYTES` as a no-overlap comparison — the invariant holds statically today. Widen to
  //  `number[]` and assert it at runtime too, so it survives someone adding the row that makes it possible.)
  test("is not a sellable plan — it has no row in PLAN_SIZES", () => {
    const sellableBytes: readonly number[] = PLAN_SIZES.map((p) => p.bytes);
    expect(sellableBytes).not.toContain(FREE_TIER_BYTES);
  });

  // If the free tier ever crept past the smallest paid plan, the upsell we show a full free vault would be
  // an offer of LESS room than they already have.
  test("is smaller than every plan we sell, so upgrading always adds room", () => {
    for (const plan of PLAN_SIZES) expect(plan.bytes).toBeGreaterThan(FREE_TIER_BYTES);
  });
});

describe("resolveFreeTierBytes — the test-only shrink knob", () => {
  test("hands out the real free tier when nothing overrides it", () => {
    expect(resolveFreeTierBytes(undefined, "sandbox")).toBe(FREE_TIER_BYTES);
    expect(resolveFreeTierBytes(undefined, "production")).toBe(FREE_TIER_BYTES);
  });

  test("a non-production deployment can shrink it — e.g. 1 GB, to fill a test vault in one upload", () => {
    expect(resolveFreeTierBytes(1_000_000_000, "sandbox")).toBe(1_000_000_000);
  });

  // THE point of the function. "25 GB forever" is a promise; a stray env var, a copied Vercel project or a
  // merged test branch must not be able to break it under real customers. Production ignores the knob.
  test("PRODUCTION IGNORES IT — the promise cannot be shrunk by config", () => {
    expect(resolveFreeTierBytes(1_000_000_000, "production")).toBe(FREE_TIER_BYTES);
  });
});
