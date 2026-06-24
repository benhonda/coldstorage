/**
 * Get info — a details modal reached from the row dropdown / double-click, NOT an auto-opening panel.
 * Shows one file's details (or a folder/multi summary). Retrieving a copy lives here as a **secondary**
 * action, never a promoted CTA: the product's job is to upload + hold files; getting a copy back is
 * available, not advertised.
 */
import type { ArchivedFile } from "./model.ts";
import { formatBytes, formatDate } from "./model.ts";
import { KindIcon, statusLabel } from "./StatusBadge.tsx";
import { Button, Icon, KeyValueRow, Modal } from "../../ui/primitives.tsx";

/** Resolved selection passed in by the browser. `files` = concrete files (folders expanded). */
export interface SelectionSummary {
  /** Single file when exactly one file row is selected. */
  file: ArchivedFile | null;
  /** Single folder when exactly one folder row is selected. */
  folder: { name: string; count: number } | null;
  /** Number of selected rows. */
  items: number;
  /** Concrete files the selection covers. */
  count: number;
  bytes: number;
  /** Files that are frozen and so can be retrieved. */
  restorable: ArchivedFile[];
}

export const InfoModal = ({
  sel,
  onDownload,
  onShowInFinder,
  onClose,
}: {
  sel: SelectionSummary;
  onDownload: () => void;
  onShowInFinder: (file: ArchivedFile) => void;
  onClose: () => void;
}): React.JSX.Element => {
  const localFile = sel.file && sel.file.status === "here" ? sel.file : null;
  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
      {localFile && (
        <Button variant="secondary" icon="folder_open" onClick={() => onShowInFinder(localFile)}>
          Show in Finder
        </Button>
      )}
      {sel.restorable.length > 0 && (
        <Button variant="secondary" icon="download" onClick={onDownload}>
          {sel.restorable.length > 1 ? `Request ${sel.restorable.length} copies…` : "Request a copy…"}
        </Button>
      )}
    </>
  );

  const title = sel.file
    ? (sel.file.relativePath.split("/").at(-1) ?? "Details")
    : sel.folder
      ? sel.folder.name
      : `${sel.items} items`;

  return (
    <Modal title={title} {...(sel.file ? {} : { icon: "folder" })} onClose={onClose} footer={footer}>
      {sel.file ? (
        <div className="cs-info">
          <div className="cs-info-thumb">
            <KindIcon kind={sel.file.kind} size={48} />
          </div>
          <div>
            <KeyValueRow label="Kind" value={sel.file.kind} />
            <KeyValueRow label="Size" value={formatBytes(sel.file.size)} />
            <KeyValueRow label="Status" value={statusLabel(sel.file.status)} />
            <KeyValueRow label="Uploaded" value={formatDate(sel.file.date)} />
            {sel.file.status === "gettingBack" && sel.file.readyBy && (
              <KeyValueRow label="Ready by" value={formatDate(sel.file.readyBy)} accent />
            )}
            {sel.file.status === "here" && sel.file.localPath && (
              <KeyValueRow label="On disk" value={sel.file.localPath} />
            )}
          </div>
        </div>
      ) : (
        <div>
          <KeyValueRow label="Files" value={sel.count} />
          <KeyValueRow label="Total size" value={formatBytes(sel.bytes)} />
          {sel.restorable.length > 0 && sel.restorable.length !== sel.count && (
            <KeyValueRow label="Frozen" value={sel.restorable.length} />
          )}
        </div>
      )}
    </Modal>
  );
};
