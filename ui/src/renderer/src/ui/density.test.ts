/**
 * The stored-value guard. A density that isn't one we ship must never reach `<html data-density>`: the
 * CSS would match nothing, the app would render comfortable, and the Preferences control would show a
 * selection the screen doesn't agree with.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_DENSITY, DENSITY_OPTIONS, normalizeDensity } from "./density.ts";

describe("normalizeDensity", () => {
  test("keeps every density we ship", () => {
    for (const o of DENSITY_OPTIONS) expect(normalizeDensity(o.id)).toBe(o.id);
  });

  test("a first run has no stored choice", () => {
    expect(normalizeDensity(null)).toBe(DEFAULT_DENSITY);
  });

  test("a value we don't ship falls back rather than reaching the DOM", () => {
    expect(normalizeDensity("cozy")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("")).toBe(DEFAULT_DENSITY);
    expect(normalizeDensity("COMPACT")).toBe(DEFAULT_DENSITY);
  });
});
