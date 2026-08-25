import { describe, expect, test } from "bun:test";
import { groupByCause } from "./FailuresPanel.tsx";
import type { ArchivedFile } from "./model.ts";

/** A mass failure is one cause across many files — the panel must read it as one fact, biggest first. */
const failed = (id: string, relativePath: string, error: string | null, sourcePath: string | null = "/src"): ArchivedFile => ({
  id, relativePath, size: 1, status: "failed", kind: "other", date: null, lastAttemptAt: null, error, sourcePath,
});

describe("groupByCause", () => {
  test("groups by the daemon's reason, biggest cause first, folders by count", () => {
    const rows = [
      failed("a", "Photos/2019/a.jpg", "AccessDenied"),
      failed("b", "Photos/2019/b.jpg", "AccessDenied"),
      failed("c", "Docs/c.pdf", "AccessDenied"),
      failed("d", "loose.txt", "Over quota"),
    ];
    const causes = groupByCause(rows);
    expect(causes.map((c) => [c.reason, c.files.length])).toEqual([["AccessDenied", 3], ["Over quota", 1]]);
    expect(causes[0]?.folders).toEqual(["Photos", "Docs"]);
    expect(causes[1]?.folders).toEqual([""]); // top level, not a folder
  });

  test("a row with no recorded reason still lands in a cause rather than vanishing", () => {
    const causes = groupByCause([failed("x", "x.bin", null)]);
    expect(causes).toHaveLength(1);
    expect(causes[0]?.files.map((f) => f.id)).toEqual(["x"]);
  });
});
