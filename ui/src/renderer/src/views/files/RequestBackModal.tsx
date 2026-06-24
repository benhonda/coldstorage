/**
 * Download confirm — getting a copy of an archived file back onto the Mac. It's a deliberate, explicit
 * step because it's paid and slow: Deep Archive thaws for hours, *then* the bytes download. So the
 * dialog sets expectations (ready-by, cost) rather than pretending it's instant, and the **save-to
 * folder is chosen here, per request** (a rare action — no global setting to maintain).
 *
 * The fee is a ROUGH placeholder — the daemon doesn't expose a retrieval-fee estimate yet (a known
 * contract gap). Shown as "~$X (estimate)". No specific provider price is asserted as fact.
 */
import { useEffect, useState } from "react";
import type { ArchivedFile } from "./model.ts";
import { formatBytes, totalBytes } from "./model.ts";
import { Button, KeyValueRow, Modal } from "../../ui/primitives.tsx";

/** Placeholder per-GB retrieval rate (USD). NOT authoritative — the daemon will quote the real fee. */
const EST_USD_PER_GB = 0.02;

const estimateUsd = (bytes: number): string => {
  const usd = Math.max(0.01, (bytes / 1_000_000_000) * EST_USD_PER_GB);
  return `~$${usd.toFixed(2)}`;
};

const fileName = (f: ArchivedFile | undefined): string => f?.relativePath.split("/").at(-1) ?? "this file";

export const RequestBackModal = ({
  files,
  chooseFolder,
  getDownloadsDir,
  onConfirm,
  onClose,
}: {
  files: ArchivedFile[];
  /** Open the native folder picker, seeded at the current folder. */
  chooseFolder: (defaultPath?: string) => Promise<string | null>;
  /** The OS Downloads dir — the default destination. */
  getDownloadsDir: () => Promise<string>;
  /** Start the transfer(s), saving into `folder`. */
  onConfirm: (folder: string) => void;
  onClose: () => void;
}): React.JSX.Element => {
  const [folder, setFolder] = useState("");

  // Default to the OS Downloads folder so the common case is one click (no typing, no picking).
  useEffect(() => {
    let live = true;
    void getDownloadsDir().then((dir) => live && setFolder((cur) => cur || dir));
    return () => {
      live = false;
    };
  }, [getDownloadsDir]);

  const pick = (): void => {
    void chooseFolder(folder || undefined).then((picked) => picked && setFolder(picked));
  };

  const bytes = totalBytes(files);
  const many = files.length > 1;
  const lead = many
    ? `Start a transfer to bring copies of ${files.length} files to your Mac.`
    : `Start a transfer to bring a copy of ${fileName(files[0])} to your Mac.`;

  return (
    <Modal
      title={many ? "Request copies" : "Request a copy"}
      icon="download"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" icon="download" disabled={!folder.trim()} onClick={() => onConfirm(folder.trim())}>
            Start transfer
          </Button>
        </>
      }
    >
      <div className="cs-quote">
        <p className="cs-quote-lead">{lead}</p>
        <KeyValueRow label={many ? "Files" : "File"} value={many ? files.length : fileName(files[0])} />
        <KeyValueRow label="Size" value={formatBytes(bytes)} />
        <KeyValueRow label="Ready in" value="~a day (up to 48h)" accent />
        <KeyValueRow label="Cost" value={`${estimateUsd(bytes)} (estimate)`} />
        <div className="cs-folderpick">
          <div className="cs-folderpick-info">
            <div className="cs-folderpick-label">Save to</div>
            <div className="cs-folderpick-path">{folder || "Downloads"}</div>
          </div>
          <Button variant="secondary" size="sm" icon="folder_open" onClick={pick}>
            Choose…
          </Button>
        </div>
        <p className="cs-note">
          Your uploaded file stays in the cloud — this saves a copy to your Mac. You can close the app;
          we'll let you know when it's ready. Deep storage wakes slowly, so there's a ready-by time, not a
          progress bar.
        </p>
      </div>
    </Modal>
  );
};
