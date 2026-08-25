/**
 * The "couldn't upload" popover — off the sidebar pill, showing the files whose upload FAILED (the journal's
 * `failed` rows, the same truth the row ⚠ shows — so this can't disagree with the tree and survives a
 * restart; transient blips never appear: they stay `uploading` and self-heal).
 *
 * **Grouped by cause, not listed by file.** A mass failure is one cause hitting everything — access denied,
 * over quota, a drive that isn't there — so 56,000 failed rows are one fact, not 56,000; the reason the
 * daemon wrote on each row (`error`) IS the grouping key. Each cause reads once, with its count and the
 * folders it landed in; per-file rows (name + the row's own actions) appear only when a cause has few
 * enough files to act on one at a time. Nothing here ever draws the whole set.
 *
 * Actions: **Try again for all** at the top — everything failed, scoped by the daemon (a fixed cause wants
 * one button, not one per reason). Per file, when shown: **Try again** (recorded source) or **Locate…**
 * (none — the user points at it), and **Remove**. Remove at scale is My Files' job: the tree and the
 * watched-folder prompt live there. No Dismiss: a list that IS the rows has nothing separate to acknowledge.
 *
 * COPY IS PLACEHOLDER — Ben gatekeeps the wording.
 */
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { ArchivedFile } from "./model.ts";
import { baseName, parentOf } from "./model.ts";
import { Button, Icon } from "../../ui/primitives.tsx";

/** Above this many files in one cause, the cause reads as a count + folders, not as rows. */
const PER_FILE_LIMIT = 20;
/** Fallback heading for a row whose reason the journal doesn't hold (pre-reason rows). PLACEHOLDER copy. */
const UNKNOWN_REASON = "Upload didn’t finish.";

interface Cause {
  reason: string;
  files: ArchivedFile[];
  /** Top-level folders the failed files sit in, most files first — the "where" for a big group. */
  folders: string[];
}

/** Fold failed rows into causes (the daemon's reason string), each with its files and folders. */
export const groupByCause = (files: ArchivedFile[]): Cause[] => {
  const byReason = new Map<string, ArchivedFile[]>();
  for (const f of files) {
    const key = f.error ?? UNKNOWN_REASON;
    const list = byReason.get(key);
    if (list) list.push(f);
    else byReason.set(key, [f]);
  }
  return [...byReason.entries()]
    .map(([reason, list]) => {
      const counts = new Map<string, number>();
      for (const f of list) {
        const top = f.relativePath.split("/")[0] ?? "";
        const folder = f.relativePath.includes("/") ? top : "";
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
      const folders = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
      return { reason, files: list, folders };
    })
    .sort((a, b) => b.files.length - a.files.length);
};

/** "in Photos and 2 more" / "at the top level". PLACEHOLDER copy. */
const whereLine = (folders: string[]): string => {
  const named = folders.filter((f) => f !== "");
  if (named.length === 0) return "at the top level";
  const [first, ...rest] = named;
  return rest.length === 0 ? `in ${first}` : `in ${first} and ${rest.length} more ${rest.length === 1 ? "folder" : "folders"}`;
};

export const FailuresPanel = ({
  files,
  onRetry,
  onLocate,
  onRemove,
  onClose,
}: {
  /** The failed rows, in tree order. */
  files: ArchivedFile[];
  /** Re-upload from recorded sources: these files, or `"all"` (every failed row, scoped daemon-side). */
  onRetry: (scope: ArchivedFile[] | "all") => void;
  /** Ask where this file is, then retry from there. */
  onLocate: (file: ArchivedFile) => void;
  /** Take the file out of the backup. */
  onRemove: (file: ArchivedFile) => void;
  onClose: () => void;
}): React.JSX.Element => {
  useEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const causes = useMemo(() => groupByCause(files), [files]);
  const retryable = files.reduce((n, f) => n + (f.sourcePath !== null ? 1 : 0), 0);

  return createPortal(
    <div className="cs-queue cs-queue--fail" onClick={(e) => e.stopPropagation()}>
      {/* PLACEHOLDER copy — Ben to finalize */}
      <div className="cs-queue-head">
        {files.length.toLocaleString()} couldn&apos;t upload
      </div>
      {causes.map((c) => (
        <div className="cs-queue-cause" key={c.reason}>
          <div className="cs-queue-row">
            <Icon name="error" size={18} />
            <div className="cs-queue-main">
              <div className="cs-queue-name">{c.reason}</div>
              <div className="cs-queue-sub">
                {c.files.length.toLocaleString()} {c.files.length === 1 ? "file" : "files"} {whereLine(c.folders)}
              </div>
            </div>
          </div>
          {c.files.length <= PER_FILE_LIMIT &&
            c.files.map((f) => (
              <div className="cs-queue-row cs-queue-row--file" key={f.id}>
                <div className="cs-queue-main">
                  <div className="cs-queue-name" title={f.relativePath}>
                    {baseName(f.relativePath)}
                  </div>
                  {parentOf(f.relativePath) && <div className="cs-queue-sub">{parentOf(f.relativePath)}</div>}
                </div>
                <div className="cs-queue-actions">
                  {f.sourcePath !== null ? (
                    <Button variant="secondary" size="sm" icon="refresh" onClick={() => onRetry([f])}>
                      Try again
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" icon="search" onClick={() => onLocate(f)}>
                      Locate…
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" aria-label={`Remove ${baseName(f.relativePath)}`} onClick={() => onRemove(f)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
        </div>
      ))}
      {retryable > 0 && (
        <div className="cs-queue-foot">
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            full
            onClick={() => {
              onRetry("all");
              onClose();
            }}
          >
            Try again for all {retryable.toLocaleString()}
          </Button>
        </div>
      )}
    </div>,
    document.body,
  );
};
