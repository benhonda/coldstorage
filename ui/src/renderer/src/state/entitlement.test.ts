/**
 * The deposit gate, tested against the real rule (no mocks — pure functions).
 *
 * Two cases matter most:
 *  - Before the free tier landed, a signed-in user with no subscription was refused every deposit and
 *    shown a paywall. Backing up is gated on ROOM, not on payment.
 *  - The gate must weigh the SIZE of the incoming deposit, not just what's already stored. Comparing a
 *    drop against the stored total alone (which lags — it's 0 on a fresh vault) let a single oversized
 *    deposit pour past the quota before the number ever caught up. `hasCapacityFor` is the fix.
 */
import { describe, expect, test } from "bun:test";
import { bytesAvailable, hasCapacityFor } from "./entitlement.ts";
import type { EntitlementStatus } from "../../../shared/ipc.ts";

const GB = 1_000_000_000;
const FREE_TIER = GB; // matches the coded free tier (FREE_TIER_BYTES in the account backend)

/** A signed-in account whose entitlement has landed. `active` is deliberately NOT a gate input. */
const entitlement = (over: Partial<EntitlementStatus> = {}): EntitlementStatus => ({
  known: true,
  active: false,
  checkingOut: false,
  quotaBytes: FREE_TIER,
  error: null,
  ...over,
});

describe("hasCapacityFor — the size-aware deposit gate", () => {
  test("a free account with room can deposit a fitting file (no subscription required)", () => {
    // 0.4 GB used, dropping 0.2 GB more → still under 1 GB.
    expect(hasCapacityFor(entitlement({ active: false }), 0.4 * GB, 0.2 * GB)).toBe(true);
  });

  test("THE bug: an empty vault refuses a deposit that would overflow the quota", () => {
    // 0 stored, but a single 5 GB drop can't fit in a 1 GB vault. Pre-fix this passed (0 < 1 GB) and 5 GB
    // sailed in. The gate now weighs the incoming size.
    expect(hasCapacityFor(entitlement(), 0, 5 * GB)).toBe(false);
  });

  test("a deposit that crosses the quota boundary is refused", () => {
    // 0.9 GB used + a 0.2 GB drop = 1.1 GB > 1 GB.
    expect(hasCapacityFor(entitlement(), 0.9 * GB, 0.2 * GB)).toBe(false);
    // Exactly filling it is allowed; one byte over is not.
    expect(hasCapacityFor(entitlement(), 0.9 * GB, 0.1 * GB)).toBe(true);
    expect(hasCapacityFor(entitlement(), 0.9 * GB, 0.1 * GB + 1)).toBe(false);
  });

  test("a full (or over-full) vault refuses even a zero-byte probe", () => {
    expect(hasCapacityFor(entitlement(), FREE_TIER, 0)).toBe(true); // exactly full: no room for MORE, but 0 fits
    expect(hasCapacityFor(entitlement(), FREE_TIER, 1)).toBe(false);
    expect(hasCapacityFor(entitlement(), 6 * GB, 0)).toBe(false); // already over (the 5.9-of-1-GB state)
  });

  test("in-flight bytes count as used — a burst can't each measure against the same stale total", () => {
    // Caller passes used = stored + in-flight. Stored 0, but 0.8 GB already uploading; a 0.3 GB drop
    // would make 1.1 GB. Without counting the in-flight 0.8, every drop in the burst would have seen 0.
    expect(hasCapacityFor(entitlement(), 0 + 0.8 * GB, 0.3 * GB)).toBe(false);
    expect(hasCapacityFor(entitlement(), 0 + 0.8 * GB, 0.1 * GB)).toBe(true);
  });

  test("paying changes the quota, not the rule — a subscriber is gated the same way", () => {
    const paid = entitlement({ active: true, quotaBytes: 500 * GB });
    expect(hasCapacityFor(paid, 400 * GB, 50 * GB)).toBe(true);
    expect(hasCapacityFor(paid, 400 * GB, 200 * GB)).toBe(false);
  });

  test("fails OPEN when the quota is unknown — dogfood mode, or a subscriber whose price left the catalog", () => {
    expect(hasCapacityFor(entitlement({ quotaBytes: null }), 999 * GB, 999 * GB)).toBe(true);
  });

  test("fails OPEN when usage is unknown — a daemon that hasn't reported yet is not a full vault", () => {
    expect(hasCapacityFor(entitlement(), null, 5 * GB)).toBe(true);
  });

  test("fails OPEN before the first entitlement check lands", () => {
    expect(hasCapacityFor(entitlement({ known: false, quotaBytes: null }), 6 * GB, 6 * GB)).toBe(true);
  });
});

describe("bytesAvailable — remaining headroom", () => {
  test("is quota minus everything already used", () => {
    expect(bytesAvailable(entitlement(), 0.4 * GB)).toBe(0.6 * GB);
    expect(bytesAvailable(entitlement(), FREE_TIER)).toBe(0);
  });

  test("goes negative when already over quota (drives the coarse 'no room' signal)", () => {
    expect(bytesAvailable(entitlement(), 6 * GB)).toBe(FREE_TIER - 6 * GB);
  });

  test("is null when quota or usage is unknown (⇒ gate fails open)", () => {
    expect(bytesAvailable(entitlement({ quotaBytes: null }), 1 * GB)).toBeNull();
    expect(bytesAvailable(entitlement(), null)).toBeNull();
  });
});
