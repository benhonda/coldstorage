/**
 * The /account PATCH contract (account.ts + survey.ts) — the wizard's only write surface.
 * These guard the properties the route relies on without re-checking: events can't be
 * un-happened, names arrive sane, and survey answers can only be catalog option ids.
 */
import { describe, expect, test } from "bun:test";
import { accountPatchSchema } from "./account.js";
import { surveySchema, SURVEY_VERSION, KEEPING_OPTIONS, FOUND_VIA_OPTIONS, type Survey } from "./survey.js";

describe("accountPatchSchema", () => {
  test("trims the display name and keeps it within 1–64 chars", () => {
    expect(accountPatchSchema.parse({ displayName: "  Sam Tarly  " })).toEqual({ displayName: "Sam Tarly" });
    expect(() => accountPatchSchema.parse({ displayName: "   " })).toThrow();
    expect(() => accountPatchSchema.parse({ displayName: "x".repeat(65) })).toThrow();
    // Trim happens BEFORE the length check — 64 real chars in whitespace padding is valid.
    expect(accountPatchSchema.parse({ displayName: ` ${"x".repeat(64)} ` })).toEqual({
      displayName: "x".repeat(64),
    });
  });

  test("events are one-way: `false` is invalid input, not a rewind", () => {
    for (const key of ["acceptTerms", "onboarded", "recoveryCodeConfirmed"] as const) {
      expect(accountPatchSchema.parse({ [key]: true })).toEqual({ [key]: true });
      expect(() => accountPatchSchema.parse({ [key]: false })).toThrow();
    }
  });

  test("rejects an empty patch", () => {
    expect(() => accountPatchSchema.parse({})).toThrow();
  });
});

describe("surveySchema", () => {
  test("accepts answers only from the option catalogs", () => {
    const full: Survey = {
      v: SURVEY_VERSION,
      keeping: [KEEPING_OPTIONS[0], KEEPING_OPTIONS[1]],
      foundVia: FOUND_VIA_OPTIONS[0],
    };
    expect(surveySchema.parse(full)).toEqual(full);
    expect(() => surveySchema.parse({ v: SURVEY_VERSION, keeping: ["everything-i-own"] })).toThrow();
    expect(() => surveySchema.parse({ v: SURVEY_VERSION, foundVia: "a-dream" })).toThrow();
  });

  test("both questions are skippable — a version-only survey is valid", () => {
    expect(surveySchema.parse({ v: SURVEY_VERSION })).toEqual({ v: SURVEY_VERSION });
  });

  test("rejects a version other than the current one", () => {
    expect(() => surveySchema.parse({ v: SURVEY_VERSION + 1, foundVia: FOUND_VIA_OPTIONS[0] })).toThrow();
  });
});
