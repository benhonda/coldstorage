/**
 * The billing state fold, tested against the real rule (pure functions, no mocks).
 *
 * The case that earns this file: a subscription read that FAILS must not render as a free account.
 * That's the bug this module exists to make unrepresentable — the old renderer caught the error into
 * `null`, and a paying customer got a card with no plan, no price and no way to cancel, under a green
 * "Active" badge fed by a separate cached flag. Both halves are asserted here: the error state, and
 * the contradiction (entitlement says subscribed, the billing server says there's no subscription).
 */
import { describe, expect, test } from "bun:test";
import {
  badgeIsRedundant,
  billingState,
  describeExpiry,
  describePaymentMethod,
  formatMoney,
  planBadge,
  subscriptionOf,
} from "./billing.ts";
import type { EntitlementStatus, SubscriptionInfo } from "../../../shared/ipc.ts";

const entitlement = (over: Partial<EntitlementStatus> = {}): EntitlementStatus => ({
  known: true,
  active: false,
  checkingOut: false,
  quotaBytes: null,
  error: null,
  ...over,
});

const sub = (over: Partial<SubscriptionInfo> = {}): SubscriptionInfo => ({
  status: "active",
  plan: { size: "1 TB", years: 3, priceId: "pri_x", amountCents: 30000, perMonthCents: 833, quotaBytes: 1e12 },
  nextBilledAt: "2027-01-03T00:00:00Z",
  cancelsAt: null,
  nextCharge: { amountCents: 30000, currency: "USD" },
  paymentMethod: { type: "card", brand: "visa", last4: "4242", expiryMonth: 9, expiryYear: 2028 },
  ...over,
});

const date = (iso: string): string => iso.slice(0, 10);

describe("a failed read is never a free account", () => {
  test("an errored subscription read is its own state, carrying the reason", () => {
    const state = billingState({ status: "error", message: "Paddle is down" }, entitlement({ active: true }));
    expect(state).toEqual({ kind: "unavailable", message: "Paddle is down" });
  });

  test("subscribed-but-unloadable is surfaced, not silently rendered as Free", () => {
    // The exact contradiction behind the reported screenshot: the webhook flag says this account pays,
    // the billing server returns no subscription. Picking either answer lies to a paying customer.
    const state = billingState({ status: "ready", value: null }, entitlement({ active: true }));
    expect(state.kind).toBe("unavailable");
  });

  test("no subscription and no entitlement is genuinely the free tier", () => {
    expect(billingState({ status: "ready", value: null }, entitlement()).kind).toBe("free");
  });

  test("an unfetched entitlement waits instead of guessing Free at a subscriber", () => {
    const state = billingState({ status: "ready", value: null }, entitlement({ known: false }));
    expect(state.kind).toBe("loading");
  });

  test("the chip shows the failure too — a silent chip is how the broken card hid", () => {
    const badge = planBadge(billingState({ status: "error", message: "boom" }, entitlement()), date);
    expect(badge.tone).toBe("danger");
  });
});

describe("precedence between the live signals", () => {
  test("an open checkout outranks a not-yet-arrived subscription", () => {
    const state = billingState({ status: "loading" }, entitlement({ checkingOut: true }));
    expect(state.kind).toBe("checkingOut");
  });

  test("a scheduled cancellation outranks Paddle's still-'active' status", () => {
    const state = billingState({ status: "ready", value: sub({ cancelsAt: "2027-03-04T00:00:00Z" }) }, entitlement({ active: true }));
    expect(state).toMatchObject({ kind: "ending", endsAt: "2027-03-04T00:00:00Z" });
  });

  test("past_due and paused each get their own state rather than reading as Active", () => {
    expect(billingState({ status: "ready", value: sub({ status: "past_due" }) }, entitlement({ active: true })).kind).toBe("pastDue");
    expect(billingState({ status: "ready", value: sub({ status: "paused" }) }, entitlement({ active: true })).kind).toBe("paused");
  });
});

describe("the chip and the panel can't disagree", () => {
  test("every state yields a badge and the panel's subscription in one derivation", () => {
    const states = [
      billingState({ status: "loading" }, entitlement()),
      billingState({ status: "error", message: "x" }, entitlement()),
      billingState({ status: "ready", value: null }, entitlement()),
      billingState({ status: "ready", value: sub() }, entitlement({ active: true })),
      billingState({ status: "ready", value: sub({ cancelsAt: "2027-03-04T00:00:00Z" }) }, entitlement({ active: true })),
      billingState({ status: "ready", value: sub({ status: "past_due" }) }, entitlement({ active: true })),
      billingState({ status: "ready", value: sub({ status: "paused" }) }, entitlement({ active: true })),
      billingState({ status: "loading" }, entitlement({ checkingOut: true })),
    ];
    for (const state of states) {
      expect(planBadge(state, date).short.length).toBeGreaterThan(0);
    }
    // Only the four subscribed states expose a subscription to render columns from.
    expect(states.filter((s) => subscriptionOf(s) !== null)).toHaveLength(4);
  });

  test("an off-catalog (legacy) price still reads as Active rather than blanking the badge", () => {
    const badge = planBadge(billingState({ status: "ready", value: sub({ plan: null }) }, entitlement({ active: true })), date);
    expect(badge).toMatchObject({ tone: "success", short: "Active" });
  });
});

describe("the chip's badge is only hidden when it would repeat the meter", () => {
  const active = billingState({ status: "ready", value: sub() }, entitlement({ active: true }));

  test("an active plan whose size the meter already names hides the duplicate badge", () => {
    expect(badgeIsRedundant(active, true)).toBe(true);
    // No meter to repeat (quota unknown) ⇒ the badge is the only place the size appears.
    expect(badgeIsRedundant(active, false)).toBe(false);
  });

  test("a warning badge survives a rendering meter", () => {
    // The regression this guards: "has a plan and no cancel date" was true of a PAST-DUE subscription
    // too, so the chip silently dropped the one warning it carries while the meter drew happily.
    for (const state of [
      billingState({ status: "ready", value: sub({ status: "past_due" }) }, entitlement({ active: true })),
      billingState({ status: "ready", value: sub({ status: "paused" }) }, entitlement({ active: true })),
      billingState({ status: "ready", value: sub({ cancelsAt: "2027-03-04T00:00:00Z" }) }, entitlement({ active: true })),
      billingState({ status: "error", message: "x" }, entitlement({ active: true })),
    ]) {
      expect(badgeIsRedundant(state, true)).toBe(false);
    }
  });
});

describe("money and card, as the customer's own bill states them", () => {
  test("the currency comes from Paddle, not a hardcoded dollar sign", () => {
    expect(formatMoney(30000, "USD")).toBe("$300.00");
    // A EUR customer must not be shown a "$" — the amount would simply be wrong.
    expect(formatMoney(30000, "EUR")).not.toContain("$");
  });

  test("a card reads as brand + last four; expiry is optional", () => {
    expect(describePaymentMethod(sub().paymentMethod!)).toBe("Visa ···· 4242");
    expect(describeExpiry(sub().paymentMethod!)).toBe("exp 09/28");
    const paypal = { type: "paypal", brand: null, last4: null, expiryMonth: null, expiryYear: null };
    expect(describePaymentMethod(paypal)).toBe("PayPal");
    expect(describeExpiry(paypal)).toBeNull();
  });
});
