import { describe, expect, test } from "bun:test";
import {
  HTTP_STATUS_TEXT,
  isGenericStatusText,
  type ServerErrorStatus,
} from "~/lib/router/http-status";
import { serverError } from "~/lib/router/server-responses.server";

/**
 * `serverError` writes `statusText`; the error screen reads it back through
 * `isGenericStatusText` to decide whether to print it or substitute its own copy.
 * The two sides never import each other, so the contract fails SILENTLY both ways
 * — the screen shows protocol jargon to a user, or throws away authored copy.
 */
describe("serverError → isGenericStatusText", () => {
  const statuses = Object.keys(HTTP_STATUS_TEXT).map(
    Number,
  ) as ServerErrorStatus[];

  test.each(statuses)("%i with no custom message reads as generic", (code) => {
    const res = serverError(code);
    expect(res.status).toBe(code);
    expect(isGenericStatusText(res.status, res.statusText)).toBe(true);
  });

  test.each(statuses)("%i with authored copy reads as authored", (code) => {
    const res = serverError(code, "Roster not found.");
    expect(res.statusText).toBe("Roster not found.");
    expect(isGenericStatusText(res.status, res.statusText)).toBe(false);
  });

  test("a status we never author (a platform 502/504) is generic", () => {
    // The regression this catches: falling through to the raw phrase would render
    // "Gateway Timeout" to a user as if someone had written it as an explanation.
    expect(isGenericStatusText(504, "Gateway Timeout")).toBe(true);
    expect(isGenericStatusText(502, "Bad Gateway")).toBe(true);
  });

  test("an empty statusText is generic", () => {
    expect(isGenericStatusText(404, "")).toBe(true);
  });
});
