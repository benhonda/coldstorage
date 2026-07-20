import { describe, expect, test } from "bun:test";
import {
  quoteCents,
  billableBytes,
  allowanceBytesFor,
  ALLOWANCE_BYTES_FREE,
  ALLOWANCE_BYTES_SUBSCRIBED,
} from "./retrieval-pricing.js";

/* The cost model these tests hold `retrieval-pricing.ts` to. Deliberately re-derived from AWS/Paddle
 * list prices HERE rather than imported from the module under test — a test that imports the
 * implementation's own constants can only prove the code is self-consistent, never that it's RIGHT.
 * If AWS or Paddle changes a price, both sides must be updated knowingly. */
const GIB = 1024 ** 3;
const THAW_USD_PER_GIB = 0.0025; // GDA bulk RestoreObject — charged on whole blob objects
const EGRESS_USD_PER_GIB = 0.09; // data transfer out — charged on what's actually downloaded
const PADDLE_RATE = 0.05;
const PADDLE_FIXED_USD = 0.5;

/** What we actually keep, in USD, after Paddle takes 5% + $0.50 of a charge of `cents`. */
const netToUsAfterPaddle = (cents: number) => (cents / 100) * (1 - PADDLE_RATE) - PADDLE_FIXED_USD;
/** What AWS bills us for a restore: thawing whole blobs, plus egressing the bytes the user downloads. */
const awsCostUsd = (thawBytes: number, egressBytes: number) =>
  (thawBytes / GIB) * THAW_USD_PER_GIB + (egressBytes / GIB) * EGRESS_USD_PER_GIB;

describe("quoteCents — the 0% margin rule", () => {
  // THE load-bearing invariant (strategy/CANON.md §7): a quote recovers AWS's cost + both
  // halves of Paddle's fee, and NOTHING more. Deliberately NOT a hardcoded-number test — it re-derives
  // the economics from list prices and asserts what we NET lands on our cost, within the 1¢ that
  // rounding up to a chargeable amount necessarily leaves.
  const jobs = [
    // The common shape: a whole-vault-ish restore, where you want ~everything in every blob thawed.
    { label: "1 GiB, fully downloaded", thaw: GIB, egress: GIB },
    { label: "10 GiB, fully downloaded", thaw: 10 * GIB, egress: 10 * GIB },
    { label: "100 GiB, fully downloaded", thaw: 100 * GIB, egress: 100 * GIB },
    { label: "1 TiB, fully downloaded", thaw: 1024 * GIB, egress: 1024 * GIB },
    { label: "2 TiB, fully downloaded", thaw: 2048 * GIB, egress: 2048 * GIB },
    { label: "10 TiB, fully downloaded", thaw: 10240 * GIB, egress: 10240 * GIB },
    // The shape a single blended rate gets WRONG: a little data out of a lot of blobs.
    { label: "10 GiB pulled from 100 GiB of blobs", thaw: 100 * GIB, egress: 10 * GIB },
    { label: "one photo (5 MiB) out of a 1 GiB blob", thaw: GIB, egress: 5 * 1024 ** 2 },
  ];

  for (const { label, thaw, egress } of jobs) {
    test(`${label}: we net our AWS cost — no margin, no subsidy`, () => {
      const net = netToUsAfterPaddle(quoteCents(thaw, egress));
      const cost = awsCostUsd(thaw, egress);
      // Never UNDER cost (that would be storage margin quietly funding retrieval)…
      expect(net).toBeGreaterThanOrEqual(cost - 0.0001);
      // …and never more than the sub-cent rounding above it (that would be margin on retrieval).
      expect(net - cost).toBeLessThan(0.01);
    });
  }

  test("prices the THAW of whole blobs, not just the bytes downloaded", () => {
    // The bug this guards: blending both costs into one per-GB rate on the DOWNLOADED bytes. It looks
    // right on a full restore (thaw ≈ egress) and silently undercharges when a little is pulled from a
    // lot of blobs — RestoreObject thaws whole 1 GiB blobs whether you want 5 MB of one or all of it.
    const thinlySpread = quoteCents(100 * GIB, 10 * GIB); // 10 GiB of files scattered across 100 GiB of blobs
    const blendedRateWouldSay = Math.ceil(
      (((10 * GIB) / GIB) * (THAW_USD_PER_GIB + EGRESS_USD_PER_GIB) + PADDLE_FIXED_USD) / (1 - PADDLE_RATE) * 100,
    );
    expect(thinlySpread).toBeGreaterThan(blendedRateWouldSay); // we must charge MORE than the naive blend
    // …and the gap is real money, not a rounding artifact: ~$0.22 of thaw we'd otherwise have eaten.
    expect((thinlySpread - blendedRateWouldSay) / 100).toBeGreaterThan(0.2);
  });

  test("bills AWS's binary GB (2^30), not a decimal 10^9 — decimal would overcharge ~7.4%", () => {
    // The classic silent-margin bug: divide the SAME bytes by 10^9 instead of 2^30, and every quote
    // carries ~7.4% of invented margin. Price one fixed payload both ways; we must be the cheaper one.
    const bytes = 100 * GIB;
    const decimalWay = Math.ceil(
      (((bytes / 1e9) * (THAW_USD_PER_GIB + EGRESS_USD_PER_GIB) + PADDLE_FIXED_USD) / (1 - PADDLE_RATE)) * 100,
    );
    expect(quoteCents(bytes, bytes)).toBeLessThan(decimalWay);
    expect(decimalWay / quoteCents(bytes, bytes)).toBeCloseTo(1.07, 1);
  });

  test("recovers Paddle's $0.50 in full — a tiny restore is not sold below cost", () => {
    // If someone drops the $0.50 recovery to make small restores prettier, we net less than AWS charges.
    expect(netToUsAfterPaddle(quoteCents(1, 1))).toBeGreaterThanOrEqual(0);
    expect(quoteCents(1, 1)).toBeGreaterThanOrEqual(53); // $0.50 grossed up for the 5% ≈ 53¢
  });

  test("is monotonic in both drivers, and returns whole cents", () => {
    let prev = 0;
    for (const gb of [1, 2, 5, 10, 50, 100]) {
      const c = quoteCents(gb * GIB, gb * GIB);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
    // More thaw for the same download costs more; more download for the same thaw costs more.
    expect(quoteCents(50 * GIB, 10 * GIB)).toBeGreaterThan(quoteCents(20 * GIB, 10 * GIB));
    expect(quoteCents(50 * GIB, 20 * GIB)).toBeGreaterThan(quoteCents(50 * GIB, 10 * GIB));
    // Egress dominates: a GiB downloaded costs far more than a GiB merely thawed.
    expect(quoteCents(GIB, 10 * GIB)).toBeGreaterThan(quoteCents(10 * GIB, GIB));
  });

  test("nothing billable is free, never a charge", () => {
    expect(quoteCents(0, 0)).toBe(0);
    expect(quoteCents(-1, -1)).toBe(0);
    expect(quoteCents(Number.NaN, Number.NaN)).toBe(0);
  });
});

describe("billableBytes — the allowance discounts, it doesn't gate", () => {
  test("a restore inside the allowance is free", () => {
    expect(billableBytes(150_000_000, ALLOWANCE_BYTES_FREE)).toBe(0);
    expect(quoteCents(0, billableBytes(150_000_000, ALLOWANCE_BYTES_FREE))).toBe(0);
  });

  test("the allowance is measured in DOWNLOADED bytes, never in thawed blob bytes", () => {
    // Getting one 5 MB photo back can require thawing the whole 1 GiB blob it sits in. If the allowance
    // were charged the thaw, a single photo would consume five months of a free user's 200 MB — killing
    // the one thing the allowance exists for. It costs us a fraction of a cent; we eat it.
    const onePhoto = 5 * 1024 ** 2;
    expect(billableBytes(onePhoto, ALLOWANCE_BYTES_FREE)).toBe(0); // free, despite a 1 GiB thaw behind it
    expect(ALLOWANCE_BYTES_FREE - onePhoto).toBeGreaterThan(0.9 * ALLOWANCE_BYTES_FREE); // barely dents it
  });

  test("a restore over the allowance bills only the OVERAGE, not the whole job", () => {
    // The anti-cliff invariant: 1.5 GB on a 1 GB allowance bills 0.5 GB — not 1.5 GB.
    expect(billableBytes(1_500_000_000, ALLOWANCE_BYTES_SUBSCRIBED)).toBe(500_000_000);
  });

  test("a spent allowance bills the full job", () => {
    expect(billableBytes(2 * GIB, 0)).toBe(2 * GIB);
  });

  test("never negative, and a negative remaining is treated as spent", () => {
    expect(billableBytes(100, 999_999)).toBe(0);
    expect(billableBytes(500, -100)).toBe(500);
  });
});

describe("allowanceBytesFor", () => {
  test("paid plans get 1 GB, the free tier gets 200 MB", () => {
    expect(allowanceBytesFor(true)).toBe(ALLOWANCE_BYTES_SUBSCRIBED);
    expect(allowanceBytesFor(false)).toBe(ALLOWANCE_BYTES_FREE);
    expect(allowanceBytesFor(true)).toBeGreaterThan(allowanceBytesFor(false));
  });

  test("the free-tier allowance stays a bounded acquisition cost (< $0.25/yr worst case)", () => {
    // Guards the economics, not the code: 12 windows/yr fully drained must stay pocket change, since no
    // revenue funds it. If someone bumps the free allowance to 1 GB, this fails and forces the math.
    // Egress-only: the allowance is measured in downloaded bytes (the thaw behind it is eaten separately
    // and is ~36× cheaper per byte).
    const worstCaseYearUsd = awsCostUsd(0, ALLOWANCE_BYTES_FREE) * 12;
    expect(worstCaseYearUsd).toBeLessThan(0.25);
  });
});
