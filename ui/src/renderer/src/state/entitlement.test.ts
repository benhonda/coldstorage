/**
 * The deposit gate, tested against the real rule (no mocks — it's a pure function).
 *
 * The case that matters most is the first one: before the free tier landed, a signed-in user with no
 * subscription was refused every deposit and shown a paywall. Backing up is gated on ROOM, not on payment.
 */
import { describe, expect, test } from "bun:test";
import { hasCapacity } from "./entitlement.ts";
import type { EntitlementStatus } from "../../../shared/ipc.ts";

const GB = 1_000_000_000;
const FREE_TIER = 25 * GB;

/** A signed-in account whose entitlement has landed. `active` is deliberately NOT a gate input. */
const entitlement = (over: Partial<EntitlementStatus> = {}): EntitlementStatus => ({
  known: true,
  active: false,
  checkingOut: false,
  quotaBytes: FREE_TIER,
  error: null,
  ...over,
});

describe("hasCapacity — the deposit gate", () => {
  test("a free account with room can deposit (no subscription required)", () => {
    expect(hasCapacity(entitlement({ active: false }), 6 * GB)).toBe(true);
  });

  test("a free account that has filled its 25 GB cannot", () => {
    expect(hasCapacity(entitlement({ active: false }), FREE_TIER)).toBe(false);
    expect(hasCapacity(entitlement({ active: false }), 30 * GB)).toBe(false);
  });

  test("paying changes the quota, not the rule — a subscriber is gated the same way", () => {
    const paid = entitlement({ active: true, quotaBytes: 500 * GB });
    expect(hasCapacity(paid, 400 * GB)).toBe(true);
    expect(hasCapacity(paid, 500 * GB)).toBe(false);
  });

  test("an empty vault always has room", () => {
    expect(hasCapacity(entitlement(), 0)).toBe(true);
  });

  test("fails OPEN when the quota is unknown — dogfood mode, or a subscriber whose price left the catalog", () => {
    expect(hasCapacity(entitlement({ quotaBytes: null }), 999 * GB)).toBe(true);
  });

  test("fails OPEN when usage is unknown — a daemon that hasn't reported yet is not a full vault", () => {
    expect(hasCapacity(entitlement(), null)).toBe(true);
  });

  test("fails OPEN before the first entitlement check lands", () => {
    expect(hasCapacity(entitlement({ known: false, quotaBytes: null }), 6 * GB)).toBe(true);
  });
});
