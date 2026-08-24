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
 *
 * A paid restore keeps this dialog OPEN while the payment clears ({@link RequestBackModal.paying}) rather
 * than closing on confirm and leaving the browser round-trip invisible. Same shape as sign-in and the plan
 * picker: say what we're waiting for, offer the lost tab back, and always offer a way out.
 */
import { useEffect, useState } from "react";
import type { RetrievalQuote } from "../../../../shared/ipc.ts";
import type { ArchivedFile } from "./model.ts";
import { formatBytes, totalBytes } from "./model.ts";
import { Button, KeyValueRow, Modal } from "../../ui/primitives.tsx";
import { formatMoney } from "../../state/billing.ts";

const fileName = (f: ArchivedFile | undefined): string => f?.relativePath.split("/").at(-1) ?? "this file";

/** Restore quotes come back in USD cents (root RETRIEVAL.md). */
const usd = (cents: number): string => formatMoney(cents, "USD");

export const RequestBackModal = ({
  files,
  quote,
  quoteError,
  chooseFolder,
  getDownloadsDir,
  paying,
  onConfirm,
  onCancelPayment,
  onReopenCheckout,
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
  /** Set for the WHOLE payment, from the click onward — null only when nothing is being charged.
   *  `starting` = the charge request is in flight (so the confirm button is already gone and can't fire
   *  twice); `browser` = Paddle checkout was opened and there's a tab to point them back at; `card` = a
   *  saved card is being charged in place, so there is no tab and no "reopen" to offer. */
  paying: { phase: "starting" | "browser" | "card" } | null;
  /** Start the download, saving into `folder`. Pays first if the quote isn't free. */
  onConfirm: (folder: string) => void;
  /** Walk away mid-payment: stops the wait and hands the quote back to the allowance. */
  onCancelPayment: () => void;
  /** Reopen the checkout tab (only offered when one was opened). */
  onReopenCheckout: () => void;
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
    ? `Download copies of ${files.length} files to your Mac.`
    : `Download a copy of ${fileName(files[0])} to your Mac.`;

  const free = quote !== null && quote.quoteCents === 0;
  const pending = quote === null && quoteError === null;
  // Never let someone commit to a download we couldn't price — they'd be agreeing to an unknown charge.
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
      title="Request a download"
      icon="download"
      onClose={paying ? onCancelPayment : onClose}
      footer={
        paying ? (
          <>
            <Button variant="ghost" onClick={onCancelPayment}>
              Never mind
            </Button>
            {paying.phase === "browser" && (
              <Button variant="secondary" onClick={onReopenCheckout}>
                Reopen checkout
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" icon="download" disabled={!canStart} onClick={() => onConfirm(folder.trim())}>
              {free || quote === null ? "Start download" : `Pay ${usd(quote.quoteCents)} and start`}
            </Button>
          </>
        )
      }
    >
      {paying ? (
        <div className="cs-quote">
          <p className="cs-quote-lead">
            {paying.phase === "starting"
              ? "Starting your payment…"
              : paying.phase === "browser"
                ? "Finish paying in your browser. This starts the download on its own once the payment goes through — you can leave this open."
                : "Taking the payment from your card on file. This starts the download on its own once it goes through."}
          </p>
          {/* The price stays on screen while it's being charged — it's the fact they just agreed to. */}
          <KeyValueRow label={many ? "Files" : "File"} value={many ? files.length : fileName(files[0])} />
          <KeyValueRow label="Cost" value={priceValue} accent />
          <p className="cs-note">
            Nothing has been charged until it goes through, and backing out here costs you nothing — the
            download just doesn&apos;t start.
          </p>
        </div>
      ) : (
      <>
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
      </>
      )}
    </Modal>
  );
};
