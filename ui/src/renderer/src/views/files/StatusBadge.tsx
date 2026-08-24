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
  // which no byte moves; `transferring` is bytes actually landing. Both are drawn from the same circle
  // family so they read as one journey, and the RING carries the difference: `downloading`'s ring is
  // broken (headed here, nothing arriving yet), `arrow_circle_down`'s is closed (arriving now). An
  // hourglass used to hold `pending`, but a bare hourglass reads as generic "loading" — and a spinner
  // next to an upload queue reads as uploading, which is the one thing it isn't (Ben, 2026-08-24).
  pending: { icon: "downloading", tone: "warning", label: "Waiting on deep storage" },
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

/** A small colored status icon — ✓ stored, ↑ uploading, ⚠ couldn't upload, ↓-in-a-broken-ring waiting on
 * deep storage, ↓ downloading, or saved-here.
 *
 * `pending` breathes (see `.cs-pulse`), because a thaw is the one state where something is happening that
 * the user cannot see any evidence of. `alive` is how a caller turns that off: it means "we still believe
 * this wait", and the Downloads page clears it when `restoreStall` says we've lost track — a wait nobody
 * can vouch for must not keep signalling life. The file tree has no stall verdict of its own to pass, so
 * it takes the default; that seam is the reason this is a prop and not a lookup inside STATUS.
 *
 * `reason` is the daemon's own words for what went wrong (`ArchivedFile.error`), appended to the label so a
 * stuck row can say WHY rather than leaving the user to guess from a glyph. The journal has carried this
 * string since failures were first persisted; nothing showed it until now. */
export const StatusIcon = ({
  status,
  reason = null,
  size = 20,
  alive = true,
}: {
  status: FileStatus;
  reason?: string | null;
  size?: number;
  alive?: boolean;
}): React.JSX.Element | null => {
  const s = STATUS[status];
  if (!s) return null;
  const label = reason ? `${s.label} — ${reason}` : s.label;
  const pulse = alive && status === "pending" ? " cs-pulse" : "";
  return (
    <span className={`cs-statusicon cs-statusicon--${s.tone}${pulse}`} role="img" aria-label={label} title={label}>
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
