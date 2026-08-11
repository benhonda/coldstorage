import { describe, expect, test } from "bun:test";
import { maskEmail } from "./log.js";

describe("maskEmail", () => {
  test("keeps one character of the local part and nothing else", () => {
    expect(maskEmail("ben@example.com")).toBe("b**@*******.***");
  });

  test("no input survives intact — the point is that logs can't be harvested", () => {
    for (const email of ["ben@example.com", "a@b.co", "first.last+tag@sub.domain.org"]) {
      const masked = maskEmail(email);
      // The domain is the part most likely to be leaked by a naive mask; assert it's gone.
      expect(masked).not.toContain(email.slice(email.lastIndexOf("@") + 1));
      expect(masked.length).toBe(email.length);
    }
  });

  test("a single-character local part leaves no asterisks to give away a length", () => {
    expect(maskEmail("a@b.co")).toBe("a@*.**");
  });

  test("something that isn't an address is masked completely rather than passed through", () => {
    expect(maskEmail("not-an-email")).toBe("************");
  });
});
