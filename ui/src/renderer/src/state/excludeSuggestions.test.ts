/**
 * The suggestion derivation, tested against the real rule (pure functions, no mocks).
 *
 * The cases that earn this file are the two ways this feature could hurt someone: a pack reporting itself
 * "on" when the user has removed one of its patterns (so the app claims to be skipping something it isn't,
 * and vice versa), and the prompt floor — get that wrong and a backup app interrupts every single drop to
 * argue about four kilobytes.
 */
import { describe, expect, test } from "bun:test";
import type { DepositPreviewItem, ExcludeSuggestion } from "../../../daemon/protocol.ts";
import {
  PROMPT_FLOOR,
  matchesInDrop,
  missingPatterns,
  packState,
  presentPatterns,
  worthPrompting,
} from "./excludeSuggestions.ts";

const pack = (id: string, patterns: string[]): ExcludeSuggestion => ({
  id,
  title: id,
  detail: `${id} detail`,
  patterns,
});
const dev = pack("dev", ["dist", "build"]);
const vms = pack("vms", ["*.vmdk"]);

const item = (over: Partial<DepositPreviewItem> = {}): DepositPreviewItem => ({
  relativePath: "a.txt",
  size: 0,
  exists: false,
  suggestedPack: null,
  ...over,
});

describe("packState", () => {
  test("off when none of its patterns are excluded", () => {
    expect(packState(dev, [])).toBe("off");
    expect(packState(dev, ["node_modules", "*.tmp"])).toBe("off"); // unrelated excludes don't count
  });

  test("on only when every pattern is excluded", () => {
    expect(packState(dev, ["dist", "build"])).toBe("on");
    expect(packState(dev, ["build", "dist", "node_modules"])).toBe("on");
  });

  // The honest middle. A user who turned the pack on and then deleted the `build` chip has NOT asked for
  // it back — reporting "on" would claim we're skipping build folders when we aren't.
  test("partial when the user has removed one of its chips", () => {
    expect(packState(dev, ["dist"])).toBe("partial");
    expect(missingPatterns(dev, ["dist"])).toEqual(["build"]);
  });

  test("missingPatterns is exactly what turning it on would add", () => {
    expect(missingPatterns(dev, [])).toEqual(["dist", "build"]);
    expect(missingPatterns(dev, ["dist", "build"])).toEqual([]);
  });

  test("presentPatterns is exactly what turning it off would remove", () => {
    expect(presentPatterns(dev, ["dist"])).toEqual(["dist"]);
    expect(presentPatterns(dev, [])).toEqual([]);
    // Never reaches past its own pack — an unrelated exclude is not this pack's to remove.
    expect(presentPatterns(dev, ["dist", "build", "node_modules"])).toEqual(["dist", "build"]);
  });

  // add-then-remove returns the list to where it started: the two halves of the shelf are exact inverses,
  // so a pack can't leave residue behind after being turned on and off.
  test("add then remove is a round trip", () => {
    const after = [...missingPatterns(dev, [])];
    expect(packState(dev, after)).toBe("on");
    const back = after.filter((p) => !presentPatterns(dev, after).includes(p));
    expect(back).toEqual([]);
    expect(packState(dev, back)).toBe("off");
  });
});

describe("matchesInDrop", () => {
  test("totals files and bytes per pack, heaviest first", () => {
    const preview = [
      item({ relativePath: "p/keep.jpg", size: 900 }),
      item({ relativePath: "p/dist/a.js", size: 10, suggestedPack: "dev" }),
      item({ relativePath: "p/dist/b.js", size: 20, suggestedPack: "dev" }),
      item({ relativePath: "p/box.vmdk", size: 500, suggestedPack: "vms" }),
    ];
    expect(matchesInDrop(preview, [dev, vms])).toEqual([
      { pack: vms, files: 1, bytes: 500 },
      { pack: dev, files: 2, bytes: 30 },
    ]);
  });

  test("packs with nothing in this drop are left out entirely", () => {
    expect(matchesInDrop([item({ size: 5 })], [dev, vms])).toEqual([]);
  });

  // A tag for a pack the app doesn't know about (daemon ahead of the app) must not crash or invent a row.
  test("ignores a tag with no matching pack", () => {
    expect(matchesInDrop([item({ size: 5, suggestedPack: "ghost" })], [dev])).toEqual([]);
  });
});

describe("worthPrompting", () => {
  test("stays out of the way below both floors", () => {
    expect(worthPrompting([{ pack: dev, files: 4, bytes: 4096 }])).toBe(false);
    expect(worthPrompting([])).toBe(false);
  });

  test("either floor alone is enough", () => {
    expect(worthPrompting([{ pack: dev, files: 1, bytes: PROMPT_FLOOR.bytes }])).toBe(true);
    expect(worthPrompting([{ pack: dev, files: PROMPT_FLOOR.files, bytes: 1 }])).toBe(true);
  });

  test("floors are met by the whole drop, not by one pack", () => {
    const half = PROMPT_FLOOR.bytes / 2;
    expect(worthPrompting([{ pack: dev, files: 1, bytes: half }])).toBe(false);
    expect(
      worthPrompting([
        { pack: dev, files: 1, bytes: half },
        { pack: vms, files: 1, bytes: half },
      ]),
    ).toBe(true);
  });
});
