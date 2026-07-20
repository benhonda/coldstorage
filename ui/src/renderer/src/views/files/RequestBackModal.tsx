/**
 * Download confirm — getting a copy of an archived file back onto the Mac. It's a deliberate, explicit
 * step because it's slow and (past a point) paid: Deep Archive thaws for hours, *then* the bytes download.
 * So the dialog sets expectations (ready-by, price) rather than pretending it's instant, and the
 * **save-to folder is chosen here, per request** (a rare action — no global setting to maintain).
 *
 * THE PRICE COMES FROM THE BACKEND (`quoteRestore` → `POST /retrieval/quote`), never from the daemon's
 * local rate card. This is not a style preference: the rate card quotes AWS's *thaw* rate alone, with no
 * egress (36× larger), no payment fee, and no knowledge of this account's free monthly allowance —
 * quoting from it understated the real charge by roughly 40× (root `RETRIEVAL.md`, 2026-07-13). One
 * price, from the party that actually charges it.
 *
 * Most restores land free: they fit inside the monthly allowance, and the dialog just says so. Only when
 * there's genuinely something to pay does it show a price — and then it says the number plainly, with no
 * apology and no drama (CANON §5).
 */
import { useEffect, useState } from "react";
import type { RetrievalQuote } from "../../../../shared/ipc.ts";
import type { ArchivedFile } from "./model.ts";
import { formatBytes, totalBytes } from "./model.ts";
import { Button, KeyValueRow, Modal } from "../../ui/primitives.tsx";

const fileName = (f: ArchivedFile | undefined): string => f?.relativePath.split("/").at(-1) ?? "this file";

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const RequestBackModal = ({
  files,
  quote,
  quoteError,
  chooseFolder,
  getDownloadsDir,
  onConfirm,
  onClose,
}: {
  files: ArchivedFile[];
  /** The backend's price for this restore. `null` while it's still being fetched. */
  quote: RetrievalQuote | null;
  /** Set if the quote couldn't be fetched — we then refuse to guess a price rather than show a wrong one. */
  quoteError: string | null;
  /** Open the native folder picker, seeded at the current folder. */
  chooseFolder: (defaultPath?: string) => Promise<string | null>;
  /** The OS Downloads dir — the default destination. */
  getDownloadsDir: () => Promise<string>;
  /** Start the transfer(s), saving into `folder`. Pays first if the quote isn't free. */
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

  const free = quote !== null && quote.quoteCents === 0;
  const pending = quote === null && quoteError === null;
  // Never let someone commit to a transfer we couldn't price — they'd be agreeing to an unknown charge.
  const canStart = folder.trim() !== "" && quote !== null;

  const priceValue = pending
    ? "Checking…"
    : quoteError !== null
      ? "Couldn't check"
      : free
        ? "Free"
        : usd(quote!.quoteCents);

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
          <Button variant="primary" icon="download" disabled={!canStart} onClick={() => onConfirm(folder.trim())}>
            {free || quote === null ? "Start transfer" : `Pay ${usd(quote.quoteCents)} and start`}
          </Button>
        </>
      }
    >
      <div className="cs-quote">
        <p className="cs-quote-lead">{lead}</p>
        <KeyValueRow label={many ? "Files" : "File"} value={many ? files.length : fileName(files[0])} />
        <KeyValueRow label="Size" value={formatBytes(bytes)} />
        <KeyValueRow label="Ready in" value={quote?.typicalWait ?? "…"} accent />
        <KeyValueRow label="Cost" value={priceValue} />
        <div className="cs-folderpick">
          <div className="cs-folderpick-info">
            <div className="cs-folderpick-label">Save to</div>
            <div className="cs-folderpick-path">{folder || "Downloads"}</div>
          </div>
          <Button variant="secondary" size="sm" icon="folder_open" onClick={pick}>
            Choose…
          </Button>
        </div>

        {quoteError !== null && (
          // We know the price is unknown, so we say that — rather than show a stale or guessed number and
          // charge something else. Recoverable: closing and reopening re-quotes.
          <p className="cs-note">We couldn't check the cost just now ({quoteError}). Close and try again in a moment.</p>
        )}

        {free && (
          <p className="cs-note">
            This one's included — it fits in your free monthly download allowance, so there's nothing to pay.
          </p>
        )}

        {quote !== null && !free && (
          <p className="cs-note">
            Downloads cost what they cost us — this is the price to pull {formatBytes(quote.billableBytes)} out of deep
            storage, passed straight through.
            {quote.allowanceBytes > 0 && ` The first ${formatBytes(quote.allowanceBytes)} is covered by your free monthly allowance.`}
          </p>
        )}

        <p className="cs-note">
          Your uploaded file stays in the cloud — this saves a copy to your Mac. You can close the app; we'll let you
          know when it's ready. Deep storage wakes slowly, so there's a ready-by time, not a progress bar.
        </p>
      </div>
    </Modal>
  );
};
