/**
 * Presentation for a file's {@link FileStatus} and {@link FileKind}. Status shows as a small colored
 * icon (by the row's ⋯), NOT a text pill or a column — and `frozen` (the resting default) shows nothing,
 * since a marker on every row is just noise. Mapping lives here so every surface reads the same.
 */
import type { FileKind, FileStatus } from "./model.ts";
import { Icon } from "../../ui/primitives.tsx";

type Tone = "accent" | "warning" | "success";

/**
 * Non-resting states only; `frozen` → null (no icon). Colors kept from the badges Ben liked. Icons are
 * the circle family (arrow centered in the glyph, not tucked in a cloud), matching the saved check.
 */
const STATUS: Record<FileStatus, { icon: string; tone: Tone; label: string } | null> = {
  frozen: null,
  uploading: { icon: "arrow_circle_up", tone: "accent", label: "Uploading" },
  gettingBack: { icon: "arrow_circle_down", tone: "warning", label: "Transferring" },
  here: { icon: "check_circle", tone: "success", label: "Saved on this Mac" },
};

const KIND_ICON: Record<FileKind, string> = {
  photo: "image",
  video: "movie",
  audio: "music_note",
  document: "description",
  archive: "folder_zip",
  other: "draft",
};

/** A small colored status icon — upload / download in flight, or a green check once saved locally. */
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
export const statusLabel = (status: FileStatus): string => STATUS[status]?.label ?? "Frozen";
