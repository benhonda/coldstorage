/**
 * STAND-IN for the daemon's future `listFiles` read (not built yet — see ELECTRON-UI-DESIGN.md,
 * "Daemon contract gaps this design needs"). This is a realistic vault so the browser, rollups,
 * reorganize and request-back flows can be designed and visually verified against true-to-life data.
 *
 * When `listFiles` lands: add it to `protocol.ts` (the Swift mirror), fetch it in the controller into
 * the store, and have {@link file:./useFiles.ts} read from there instead of this seed. The
 * {@link ArchivedFile} shape here is exactly what `listFiles` should return, so nothing else changes.
 *
 * Dates are fixed ISO strings (deterministic — no wall-clock), sizes are plausible bytes.
 */
import type { ArchivedFile } from "./model.ts";
import { kindFromName } from "./model.ts";

const f = (
  id: string,
  relativePath: string,
  size: number,
  status: ArchivedFile["status"],
  date: string,
  extra: Partial<ArchivedFile> = {},
): ArchivedFile => ({ id, relativePath, size, status, date, kind: kindFromName(relativePath), ...extra });

const MB = 1_000_000;
const GB = 1_000_000_000;

/** ~12 GB across a believable mix of living (Photos) and done (Documents, Projects) folders. */
export const fixtureFiles: ArchivedFile[] = [
  // Photos — the "living" library, the big one.
  f("ph-0001", "Photos/2019/beach.jpg", 4.1 * MB, "frozen", "2019-07-12T16:02:00Z"),
  f("ph-0002", "Photos/2019/sunset.jpg", 3.8 * MB, "here", "2019-07-12T19:44:00Z", {
    localPath: "/Users/ben/Downloads/Restores/sunset.jpg",
  }),
  f("ph-0003", "Photos/2019/hike.mov", 2.3 * GB, "gettingBack", "2019-08-03T11:20:00Z", {
    readyBy: "2026-06-25T18:00:00Z",
  }),
  f("ph-0004", "Photos/2019/january/snow.jpg", 5.2 * MB, "frozen", "2019-01-05T09:00:00Z"),
  f("ph-0005", "Photos/2019/january/cabin.jpg", 6.0 * MB, "frozen", "2019-01-06T15:30:00Z"),
  f("ph-0006", "Photos/2024/wedding.mov", 4.7 * GB, "frozen", "2024-09-21T22:10:00Z"),
  f("ph-0007", "Photos/2024/portrait.heic", 2.9 * MB, "frozen", "2024-03-03T13:05:00Z"),
  f("ph-0008", "Photos/2024/garden.png", 7.4 * MB, "frozen", "2024-05-18T08:42:00Z"),
  f("ph-0009", "Photos/2024/trip/venice.jpg", 4.4 * MB, "frozen", "2024-06-01T10:00:00Z"),
  f("ph-0010", "Photos/2024/trip/canal.jpg", 4.0 * MB, "frozen", "2024-06-01T10:14:00Z"),
  f("ph-0011", "Photos/2024/trip/clip.mp4", 880 * MB, "frozen", "2024-06-02T17:30:00Z"),

  // Documents — "done" folders, just deposited.
  f("dc-0001", "Documents/taxes-2023.pdf", 1.2 * MB, "frozen", "2024-04-10T12:00:00Z"),
  f("dc-0002", "Documents/lease.pdf", 840_000, "frozen", "2023-11-01T09:30:00Z"),
  f("dc-0003", "Documents/resume.docx", 120_000, "here", "2025-02-14T16:00:00Z", {
    localPath: "/Users/ben/Downloads/Restores/resume.docx",
  }),
  f("dc-0004", "Documents/notes/ideas.md", 18_000, "frozen", "2025-12-30T20:00:00Z"),
  f("dc-0005", "Documents/notes/reading.md", 9_400, "frozen", "2026-01-15T07:45:00Z"),

  // Projects — mixed, one mid-archive (a live deposit feel).
  f("pj-0001", "Projects/coldstorage/spec.pdf", 2.6 * MB, "frozen", "2026-05-02T14:00:00Z"),
  f("pj-0002", "Projects/coldstorage/demo.mov", 540 * MB, "uploading", "2026-06-24T09:00:00Z"),
  f("pj-0003", "Projects/archive-2018.zip", 3.1 * GB, "frozen", "2018-12-31T23:59:00Z"),

  // A couple of loose root files.
  f("rt-0001", "readme.txt", 4_200, "frozen", "2026-06-01T00:00:00Z"),
  f("rt-0002", "old-backup.dmg", 1.4 * GB, "frozen", "2022-02-02T02:02:00Z"),
];
