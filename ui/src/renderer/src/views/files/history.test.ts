/** Headless tests for the explorer's back/forward history (bun test, no React). */
import { describe, expect, test } from "bun:test";
import { back, canGoBack, canGoForward, currentDir, forward, initialHistory, push, remapHistory } from "./history.ts";

describe("push / back / forward", () => {
  test("opens at root with nowhere to go", () => {
    const h = initialHistory();
    expect(currentDir(h)).toBe("");
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  test("push records a dir; back and forward walk it", () => {
    let h = push(push(initialHistory(), "a"), "a/b");
    expect(currentDir(h)).toBe("a/b");
    h = back(h);
    expect(currentDir(h)).toBe("a");
    expect(canGoForward(h)).toBe(true);
    h = back(h);
    expect(currentDir(h)).toBe("");
    expect(canGoBack(h)).toBe(false);
    expect(back(h)).toBe(h); // no-op at the start
    h = forward(forward(h));
    expect(currentDir(h)).toBe("a/b");
    expect(forward(h)).toBe(h); // no-op at the end
  });

  test("pushing after going back forgets the old forward entries", () => {
    let h = push(push(initialHistory(), "a"), "a/b");
    h = push(back(h), "c");
    expect(h.entries).toEqual(["", "a", "c"]);
    expect(canGoForward(h)).toBe(false);
  });

  test("pushing the current dir is a no-op", () => {
    const h = push(initialHistory(), "a");
    expect(push(h, "a")).toBe(h);
  });
});

describe("remapHistory", () => {
  const h = { entries: ["", "old", "old/sub", "other"], index: 2 };

  test("renames every entry under a moved folder, cursor follows", () => {
    const r = remapHistory(h, (d) => (d === "old" || d.startsWith("old/") ? d.replace(/^old/, "new") : d));
    expect(r.entries).toEqual(["", "new", "new/sub", "other"]);
    expect(currentDir(r)).toBe("new/sub");
  });

  test("drops vanished entries; the cursor falls back to the nearest survivor before it", () => {
    const r = remapHistory(h, (d) => (d === "old" || d.startsWith("old/") ? null : d));
    expect(r.entries).toEqual(["", "other"]);
    expect(currentDir(r)).toBe("");
    expect(canGoForward(r)).toBe(true);
  });

  test("collapses adjacent duplicates created by the remap", () => {
    const r = remapHistory({ entries: ["", "a", "a/b"], index: 2 }, (d) => (d === "a/b" ? "a" : d));
    expect(r.entries).toEqual(["", "a"]);
    expect(currentDir(r)).toBe("a");
  });

  test("never returns an empty history", () => {
    expect(remapHistory(h, () => null)).toEqual(initialHistory());
  });
});
