import { describe, expect, test } from "bun:test";
import { isActiveStatus } from "~/paddle-status";
import type { SubscriptionStatus } from "@paddle/paddle-node-sdk";

describe("isActiveStatus", () => {
  test("active and trialing keep uploads enabled", () => {
    expect(isActiveStatus("active")).toBe(true);
    expect(isActiveStatus("trialing")).toBe(true);
  });

  test("canceled, past_due, and paused gate uploads off", () => {
    const gated: SubscriptionStatus[] = ["canceled", "past_due", "paused"];
    for (const status of gated) {
      expect(isActiveStatus(status)).toBe(false);
    }
  });
});
