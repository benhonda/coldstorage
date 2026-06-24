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
  gettingBack: { icon: "arrow_circle_down", tone: "warning", label: "Transferring" },
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

/** A small colored status icon — ✓ stored, ↑ uploading, ⚠ couldn't upload, ↓ transferring, or saved-here. */
export const StatusIcon = ({ status, size = 20 }: { status: FileStatus; size?: number }): React.JSX.Element | null => {
  const s = STATUS[status];
  if (!s) return null;
  return (
    <span className={`cs-statusicon cs-statusicon--${s.tone}`} role="img" aria-label={s.label} title={s.label}>
      <Icon name={s.icon} size={size} />
    </span>
  );
};

/** A file-type glyph (sized for a list row). */
export const KindIcon = ({ kind, size = 22 }: { kind: FileKind; size?: number }): React.JSX.Element => (
  <Icon name={KIND_ICON[kind]} size={size} />
);

/** Plain human label for a status — for the Get-info modal's key/value line. */
export const statusLabel = (status: FileStatus): string => STATUS[status]?.label ?? "Stored";
