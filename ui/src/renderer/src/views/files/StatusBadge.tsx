/**
 * Presentation for a file's {@link FileStatus} and {@link FileKind}. Status shows as a small colored
 * icon (by the row's ⋯), NOT a text pill or a column. Mapping lives here so every surface reads the same.
 *
 * Icons are the circle family. Two decisions (Ben, 2026-06-24):
 *   - `frozen` (stored) shows a quiet ✓ — explicit success, so the user tells stored from stuck at a
 *     glance (a silent failure used to read as "nothing happened").
 *   - the ✓ now means STORED, so `here` (a copy saved back on this Mac) is re-glyphed to `download_done`
 *     to stay distinct.
 */
import type { FileKind, FileStatus } from "./model.ts";
import { Icon } from "../../ui/primitives.tsx";

type Tone = "accent" | "warning" | "success" | "danger";

const STATUS: Record<FileStatus, { icon: string; tone: Tone; label: string } | null> = {
  frozen: { icon: "check_circle", tone: "success", label: "Stored" },
  uploading: { icon: "arrow_circle_up", tone: "accent", label: "Uploading" },
  // permanent/stuck only — a transient blip stays `uploading` (it self-heals), never shows this.
  failed: { icon: "error", tone: "danger", label: "Couldn't upload" },
  // Two states, because they are two different things. `pending` is the ~48h Deep Archive thaw, during
  // which no byte moves — an hourglass, not a down-arrow, because nothing is arriving yet. `transferring`
  // is the down-arrow it was always drawn as, now reserved for when that's actually true.
  pending: { icon: "hourglass_top", tone: "warning", label: "Waiting on deep storage" },
  // Still queued, but not getting anywhere — retrying against a snag, or untouched for longer than the
  // daemon's own window. Deliberately NOT the `failed` glyph: nothing has given up, and saying so would
  // send the user hunting for a retry button they don't need. `sync_problem` is the honest middle.
  stalled: { icon: "sync_problem", tone: "warning", label: "Upload isn't getting anywhere" },
  transferring: { icon: "arrow_circle_down", tone: "accent", label: "Downloading" },
  here: { icon: "download_done", tone: "success", label: "Saved on this Mac" },
};

const KIND_ICON: Record<FileKind, string> = {
  photo: "image",
  video: "movie",
  audio: "music_note",
  document: "description",
  archive: "folder_zip",
  other: "draft",
};

/** A small colored status icon — ✓ stored, ↑ uploading, ⚠ couldn't upload, ⧗ waiting on deep storage,
 * ↓ downloading, or saved-here.
 *
 * `reason` is the daemon's own words for what went wrong (`ArchivedFile.error`), appended to the label so a
 * stuck row can say WHY rather than leaving the user to guess from a glyph. The journal has carried this
 * string since failures were first persisted; nothing showed it until now. */
export const StatusIcon = ({
  status,
  reason = null,
  size = 20,
}: {
  status: FileStatus;
  reason?: string | null;
  size?: number;
}): React.JSX.Element | null => {
  const s = STATUS[status];
  if (!s) return null;
  const label = reason ? `${s.label} — ${reason}` : s.label;
  return (
    <span className={`cs-statusicon cs-statusicon--${s.tone}`} role="img" aria-label={label} title={label}>
      <Icon name={s.icon} size={size} />
    </span>
  );
};

/** A file-type glyph (sized for a list row). */
export const KindIcon = ({ kind, size = 22 }: { kind: FileKind; size?: number }): React.JSX.Element => (
  <Icon name={KIND_ICON[kind]} size={size} />
);

/** Plain human label for a status — for the Get-info modal's key/value line. `reason` (the daemon's
 * `error`) is appended when there is one, so the modal names the fault instead of restating the state. */
export const statusLabel = (status: FileStatus, reason: string | null = null): string => {
  const base = STATUS[status]?.label ?? "Stored";
  return reason ? `${base} — ${reason}` : base;
};
