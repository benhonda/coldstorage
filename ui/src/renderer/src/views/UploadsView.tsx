/**
 * **Uploads** — every batch this Mac has dropped or picked, plus its watched folders, **one row per thing
 * the user did**. Drop a folder of 56,930 files and you get one row, not 56,930; the daemon's journal
 * stays per-file underneath (see `uploads/model.ts` for the fold and why `depositId` is the group key).
 *
 * This page exists because a failed upload used to have nowhere to live: a count in the sidebar foot and
 * a popover that listed causes, with no room to say what happened and no button for the one case that
 * mattered — a drop interrupted by a restart, whose files sat ⚠ with nothing to do about them. The mirror
 * of Download Requests: same shape, same states-named-honestly rule, and the failures show up IN their
 * batch ("3 of 500 couldn't upload") rather than as a loose red list.
 *
 * The words for a failure come from `uploads/failure.ts`, keyed by the row's `failureKind`. The daemon's
 * `error` is developer detail (an S3 code, a thrown message): it rides quietly under a file row here and
 * under Get info, never as the headline. A batch's counts are derived from the same rows My Files draws,
 * so this page and the tree cannot disagree.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ColdstoreApi } from "../../../shared/ipc.ts";
import type { AppState } from "../state/reducer.ts";
import { Badge, Button, EmptyState, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";
import { when } from "../ui/when.ts";
import { baseName, parentOf, type ArchivedFile } from "./files/model.ts";
import { FAILURE } from "./uploads/failure.ts";
import type { BatchState, Counts, FailureGroup, FolderState, UploadBatch, UploadsFocus, UploadsModel, WatchedFolder } from "./uploads/model.ts";
import type { Exec } from "./types.ts";

type Tone = "neutral" | "accent" | "warning" | "success" | "danger";

/** Above this many files in one cause, the cause reads as a count, not as rows: nothing on this page
 * ever draws 56,930 lines. */
const PER_FILE_LIMIT = 20;

/** How each batch state reads — the wire→page translation. "Uploading" is EARNED (a run is moving its
 * files); "Waiting" says the daemon still owes it and nothing is moving right now. */
const BATCH: Record<BatchState, { label: string; tone: Tone; icon: string }> = {
  uploading: { label: "Uploading", tone: "accent", icon: "arrow_circle_up" },
  waiting: { label: "Waiting", tone: "warning", icon: "schedule" },
  didntFinish: { label: "Didn't finish", tone: "danger", icon: "error" },
  done: { label: "Done", tone: "success", icon: "check_circle" },
};

const FOLDER: Record<FolderState, { label: string; tone: Tone; icon: string }> = {
  paused: { label: "Paused", tone: "neutral", icon: "pause_circle" },
  unreachable: { label: "Unreachable", tone: "danger", icon: "error" },
  didntFinish: { label: "Didn't finish", tone: "danger", icon: "error" },
  uploading: { label: "Uploading", tone: "accent", icon: "arrow_circle_up" },
  watching: { label: "Watching", tone: "success", icon: "check_circle" },
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "2,140 stored · 12 uploading · 3 couldn't upload" — only the parts that are true. */
const countsLine = (c: UploadBatch["counts"]): string => {
  const parts: string[] = [];
  if (c.stored > 0) parts.push(`${c.stored.toLocaleString()} stored`);
  if (c.inFlight > 0) parts.push(`${c.inFlight.toLocaleString()} uploading`);
  if (c.failed > 0) parts.push(`${c.failed.toLocaleString()} couldn't upload`);
  return parts.join(" · ");
};

/** The collapsed row's account of what went wrong: the worst cause NAMED, with its count when it isn't
 * the whole batch, then its explanation — and a pointer at the rest when there is more than one cause.
 * The explanation alone ("It isn't where it was when you added it.") had no subject: a reader couldn't
 * tell what "it" was or that this was the diagnosis rather than a hint (2026-09-14). */
const failureNote = (failures: readonly FailureGroup[], counts: Counts): string | null => {
  const worst = failures[0];
  if (!worst) return null;
  const copy = FAILURE[worst.kind];
  const head = worst.files.length === counts.failed ? copy.label : `${copy.label} (${plural(worst.files.length, "file")})`;
  const others = failures.length - 1;
  const tail = others > 0 ? ` Plus ${others === 1 ? "one more reason" : `${others} more reasons`} — open the row to see each.` : "";
  // Rows with no recorded source: the one fact a retry needs is the one the app never wrote down (a drop
  // from before sources were kept), so say so and name the action that supplies it.
  const supply =
    counts.noSource === 0
      ? ""
      : counts.noSource === counts.failed
        ? " ColdStorage never recorded where these came from. Drop the folder in again and they'll upload."
        : ` ColdStorage never recorded where ${counts.noSource.toLocaleString()} of them came from — drop the folder in again for those.`;
  return `${head}. ${copy.explain}${tail}${supply}`;
};

/** The one-line explanation under a batch. Says something only when there IS something to say. */
const batchNote = (b: UploadBatch): string | null => {
  switch (b.state) {
    case "uploading":
      return null;
    case "waiting":
      return "Still to do. It picks back up on its own the next time ColdStorage runs.";
    case "didntFinish":
      return failureNote(b.failures, b.counts);
    case "done":
      return null;
  }
};

const folderNote = (f: WatchedFolder): string | null => {
  switch (f.state) {
    case "paused":
      return "Not being scanned. Resume it in Settings to pick up where it left off.";
    case "unreachable":
      return f.source.error;
    case "didntFinish":
      return failureNote(f.failures, f.counts);
    case "uploading":
    case "watching":
      return null;
  }
};

/** What the buttons operate on. Every action fans out to the daemon commands that exist — per file, per
 * batch, or per folder — and the journal underneath stays per-file. */
export interface UploadActions {
  /** Re-upload: one batch, one watched folder, or a handful of rows. */
  onRetryBatch: (b: UploadBatch) => void;
  onRetryFolder: (f: WatchedFolder) => void;
  onRetryFiles: (files: ArchivedFile[]) => void;
  onLocate: (file: ArchivedFile) => void;
  /** Locate folder…: the user points at the folder a whole batch came from, and the daemon finds each
   * row under it. The batch form of {@link onLocate} — a 56k-row drop can't be located one file at a time. */
  onLocateBatch: (b: UploadBatch) => void;
  /** Which row-level action is in flight on this row (batch id / source id), so its button can say so and
   * not fire twice — the daemon stats every row's source before it replies, which on a big batch is
   * seconds, and a batch whose rows have no source has nothing to flip optimistically meanwhile. */
  busyOn: (id: string) => "retry" | "locate" | null;
  onRemoveFile: (file: ArchivedFile) => void;
  /** Take a batch's failed files out of the backup — nothing landed for them. */
  onRemoveFailed: (b: UploadBatch) => void;
  /** Drop a finished batch from this list (its files stay in My Files). */
  onForget: (b: UploadBatch) => void;
}

/** One cause inside an expanded row: the words for it, its count, and — when there are few enough to act
 * on one at a time — the files themselves with their own buttons. */
const Cause = ({ g, a }: { g: FailureGroup; a: UploadActions }): React.JSX.Element => {
  const copy = FAILURE[g.kind];
  const shown = g.files.slice(0, PER_FILE_LIMIT);
  const rest = g.files.length - shown.length;
  return (
    <div className="cs-upload-cause">
      <div className="cs-upload-cause-head">
        <span className="cs-upload-cause-label">{copy.label}</span>
        <span className="cs-upload-cause-count">{plural(g.files.length, "file")}</span>
      </div>
      <div className="cs-upload-cause-explain">{copy.explain}</div>
      {shown.map((f) => (
        <div className="cs-upload-file" key={f.id}>
          <div className="cs-upload-file-main">
            <div className="cs-upload-file-name" title={f.relativePath}>
              {baseName(f.relativePath)}
            </div>
            {parentOf(f.relativePath) && <div className="cs-upload-file-sub">{parentOf(f.relativePath)}</div>}
            {/* The daemon's own detail — an S3 code, a thrown message. Developer-grade, so it sits last
                and quiet, but it's here: a user on the phone with support should be able to read it out. */}
            {f.error && <div className="cs-upload-file-detail">{f.error}</div>}
          </div>
          <div className="cs-upload-file-actions">
            {f.sourcePath !== null ? (
              <Button variant="secondary" size="sm" icon="refresh" onClick={() => a.onRetryFiles([f])}>
                Try again
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon="search" onClick={() => a.onLocate(f)}>
                Locate…
              </Button>
            )}
            <Button variant="ghost" size="sm" aria-label={`Remove ${baseName(f.relativePath)}`} onClick={() => a.onRemoveFile(f)}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      {rest > 0 && <div className="cs-upload-cause-more">and {plural(rest, "more file")}</div>}
    </div>
  );
};

const BatchActions = ({ b, a }: { b: UploadBatch; a: UploadActions }): React.JSX.Element => {
  const busy = a.busyOn(b.id);
  return (
  <div className="cs-download-actions">
    {/* No per-row Stop: a run is one thing, and stopping "this batch" would stop every batch in flight.
        The deposit banner on My Files owns Stop, where the bar it stops is right there. */}
    {/* Try again whenever some failed row has a source to look for: the daemon is the judge of what it can
        find, and it writes its verdict onto each row it can't. A batch where NO row has a source (a drop
        from before sources were kept) gets no button — there is nothing to judge, and the note above says
        what supplies one: drop the folder in again. */}
    {b.counts.failed > b.counts.noSource && (
      <Button variant="secondary" size="sm" icon="refresh" disabled={busy !== null} onClick={() => a.onRetryBatch(b)}>
        {busy === "retry" ? "Trying again…" : "Try again"}
      </Button>
    )}
    {/* Rows the daemon doesn't know where to find. A Photos batch never needs this: its rows re-resolve
        from the library, so a folder has nothing to say about them. */}
    {b.kind === "files" && b.counts.unlocated > 0 && (
      <Button variant="secondary" size="sm" icon="folder_open" disabled={busy !== null} onClick={() => a.onLocateBatch(b)}>
        {busy === "locate" ? "Locating…" : "Locate folder…"}
      </Button>
    )}
    {b.state === "didntFinish" && (
      <Button variant="ghost" size="sm" onClick={() => a.onRemoveFailed(b)}>
        Remove these
      </Button>
    )}
    {b.state === "done" && (
      <Button variant="ghost" size="sm" onClick={() => a.onForget(b)}>
        Remove
      </Button>
    )}
  </div>
  );
};

/** The one row shape — a batch and a watched folder differ only in what they say, not how they're drawn:
 * name + badge, a meta line, an optional note, an action strip, and (when something didn't upload) an
 * expander to the causes. */
const UploadRow = ({
  name,
  badge,
  meta,
  note,
  failures,
  actions,
  a,
  focused,
}: {
  name: string;
  badge: { label: string; tone: Tone; icon: string };
  meta: string;
  note: string | null;
  failures: FailureGroup[];
  actions: ReactNode;
  a: UploadActions;
  /** This row is what the user came here for (a ⚠ they clicked in My Files): it opens on its causes and
   * scrolls into view, so the row and its "why + what to do" are one click apart. */
  focused: boolean;
}): React.JSX.Element => {
  const expandable = failures.length > 0;
  const [open, setOpen] = useState(focused && expandable);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return (
    <div ref={ref} className={focused ? "cs-download-request cs-download-request--focused" : "cs-download-request"}>
      <div className="cs-download">
        {expandable ? (
          <button
            type="button"
            className="cs-download-expand"
            aria-expanded={open}
            aria-label={open ? "Hide what didn't upload" : "Show what didn't upload"}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "expand_more" : "chevron_right"} size={20} />
          </button>
        ) : (
          <span className="cs-download-expand cs-download-expand--none" />
        )}
        <span className={`cs-download-icon cs-download-icon--${badge.tone}`}>
          <Icon name={badge.icon} size={20} />
        </span>
        <div className="cs-download-main">
          <div className="cs-download-head">
            <span className="cs-download-name" title={name}>
              {name}
            </span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <div className="cs-download-meta">{meta}</div>
          {note && <div className="cs-download-note">{note}</div>}
        </div>
        {actions}
      </div>
      {open && (
        <div className="cs-download-children">
          {failures.map((g) => (
            <Cause key={g.kind} g={g} a={a} />
          ))}
        </div>
      )}
    </div>
  );
};

const BatchRow = ({ b, a, focused = false }: { b: UploadBatch; a: UploadActions; focused?: boolean }): React.JSX.Element => (
  <UploadRow
    focused={focused}
    name={b.name}
    badge={BATCH[b.state]}
    meta={[countsLine(b.counts), b.dest ? `in ${b.dest}` : "", `added ${when(b.createdAt)}`, b.state === "done" && b.finishedAt ? `finished ${when(b.finishedAt)}` : ""]
      .filter(Boolean)
      .join(" · ")}
    note={batchNote(b)}
    failures={b.failures}
    actions={<BatchActions b={b} a={a} />}
    a={a}
  />
);

const FolderRow = ({ f, a, focused = false }: { f: WatchedFolder; a: UploadActions; focused?: boolean }): React.JSX.Element => (
  <UploadRow
    focused={focused}
    name={f.name}
    badge={FOLDER[f.state]}
    meta={[countsLine(f.counts) || "Nothing found yet", f.source.lastScanAt ? `last checked ${when(f.source.lastScanAt)}` : ""]
      .filter(Boolean)
      .join(" · ")}
    note={folderNote(f)}
    failures={f.failures}
    actions={
      <div className="cs-download-actions">
        {/* Same rule as a batch: the button exists when there is a source for the daemon to judge. */}
        {f.counts.failed > f.counts.noSource && (
          <Button variant="secondary" size="sm" icon="refresh" disabled={a.busyOn(f.source.id) !== null} onClick={() => a.onRetryFolder(f)}>
            {a.busyOn(f.source.id) === "retry" ? "Trying again…" : "Try again"}
          </Button>
        )}
      </div>
    }
    a={a}
  />
);

export const UploadsView = ({
  api,
  exec,
  model,
  load,
  onRetryLoad,
  onRetryBatch,
  onRetryFolder,
  onRetryFiles,
  onLocate,
  onLocateBatch,
  onRemoveFile,
  onRemoveFailed,
  focus,
  onFocusShown,
}: {
  api: ColdstoreApi;
  exec: Exec;
  model: UploadsModel;
  /** The row the user came for — the batch or watched folder behind a ⚠ they clicked elsewhere. Read
   * once, when the page opens: it decides which row starts expanded and scrolled to, and nothing after. */
  focus: UploadsFocus | null;
  /** We've taken {@link focus} — the owner clears it, so a later plain visit opens the page unfocused. */
  onFocusShown: () => void;
  /** Whether the batch list is a truth yet (`AppState.depositsLoad`) — a failed read must not paint the
   * "nothing uploaded yet" hero, which would send the user off to drop files that are already here. */
  load: AppState["depositsLoad"];
  onRetryLoad: () => void;
  /** The row-level actions resolve when the daemon has answered (rejections are the caller's to toast). */
  onRetryBatch: (b: UploadBatch) => Promise<void>;
  onRetryFolder: (f: WatchedFolder) => Promise<void>;
  onRetryFiles: (files: ArchivedFile[]) => void;
  onLocate: (file: ArchivedFile) => void;
  onLocateBatch: (b: UploadBatch) => Promise<void>;
  onRemoveFile: (file: ArchivedFile) => void;
  /** Tombstone a batch's failed files — App owns this so the optimistic tree edit and the daemon call
   * happen in one place, like every other tree mutation. */
  onRemoveFailed: (b: UploadBatch) => void;
}): React.JSX.Element => {
  // Removing tens of thousands of rows is reversible in principle (re-drop the folder) but not in a
  // click, so it gets a confirm; forgetting a finished batch changes nothing in My Files and doesn't.
  const [removing, setRemoving] = useState<UploadBatch | null>(null);
  // The focus is consumed at mount: held here so the owner clearing it doesn't un-focus the row a render
  // later, and cleared upstream so the next visit to this page is a plain one.
  const [focused] = useState(focus);
  useEffect(() => {
    if (focus) onFocusShown();
  }, []); // once, on open: see above
  const isFocused = (kind: UploadsFocus["kind"], id: string): boolean => focused?.kind === kind && focused.id === id;

  // Honest pending state for the row-level actions (PILLAR5): the daemon stats every source before it
  // replies, and a batch whose rows have nothing to flip optimistically would otherwise show a button
  // that did nothing for seconds. One in flight per row; `exec` owns the error toast.
  const [busy, setBusy] = useState<Record<string, "retry" | "locate">>({});
  const track = (id: string, kind: "retry" | "locate", run: () => Promise<void>): void => {
    setBusy((b) => ({ ...b, [id]: kind }));
    exec(() =>
      run().finally(() =>
        setBusy((b) => {
          const { [id]: _done, ...rest } = b;
          return rest;
        }),
      ),
    );
  };

  const actions: UploadActions = {
    onRetryBatch: (b) => track(b.id, "retry", () => onRetryBatch(b)),
    onRetryFolder: (f) => track(f.source.id, "retry", () => onRetryFolder(f)),
    onRetryFiles,
    onLocate,
    onLocateBatch: (b) => track(b.id, "locate", () => onLocateBatch(b)),
    busyOn: (id) => busy[id] ?? null,
    onRemoveFile,
    onRemoveFailed: setRemoving,
    onForget: (b) => exec(() => api.request("forgetDeposit", { depositId: b.id })),
  };

  const inProgress = model.batches.filter((b) => b.state === "uploading" || b.state === "waiting");
  const attention = model.batches.filter((b) => b.state === "didntFinish");
  const earlier = model.batches.filter((b) => b.state === "done");
  const empty = model.batches.length === 0 && model.folders.length === 0;

  return (
    <Page title="Uploads">
      {load.state === "failed" ? (
        <EmptyState
          icon="cloud_off"
          title="Couldn't load your uploads"
          description={`Your files are safe — this is the list that failed to load: ${load.error}.`}
          action={
            <Button variant="primary" onClick={onRetryLoad}>
              Try again
            </Button>
          }
        />
      ) : empty && load.state === "pending" ? (
        <EmptyState icon="cloud_sync" title="Loading your uploads…" />
      ) : empty ? (
        <EmptyState
          icon="cloud_upload"
          title="Nothing uploaded yet"
          description="Drop files into My Files, or add a folder to watch in Settings, and they show up here as they go up."
        />
      ) : (
        <>
          {inProgress.length > 0 && (
            <section className="cs-downloads-group">
              <h2 className="cs-downloads-heading">In progress</h2>
              {inProgress.map((b) => (
                <BatchRow key={b.id} b={b} a={actions} focused={isFocused("batch", b.id)} />
              ))}
            </section>
          )}
          {attention.length > 0 && (
            <section className="cs-downloads-group">
              <h2 className="cs-downloads-heading">Needs attention</h2>
              {attention.map((b) => (
                <BatchRow key={b.id} b={b} a={actions} focused={isFocused("batch", b.id)} />
              ))}
            </section>
          )}
          {model.folders.length > 0 && (
            <section className="cs-downloads-group">
              <h2 className="cs-downloads-heading">Watched folders</h2>
              {model.folders.map((f) => (
                <FolderRow key={f.source.id} f={f} a={actions} focused={isFocused("folder", f.source.id)} />
              ))}
            </section>
          )}
          {earlier.length > 0 && (
            <section className="cs-downloads-group">
              <h2 className="cs-downloads-heading">Earlier</h2>
              {earlier.map((b) => (
                <BatchRow key={b.id} b={b} a={actions} focused={isFocused("batch", b.id)} />
              ))}
            </section>
          )}
        </>
      )}

      {removing && (
        <Modal
          title={`Remove ${plural(removing.counts.failed, "file")} from ${removing.name}?`}
          icon="delete"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                Keep them
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onRemoveFailed(removing);
                  setRemoving(null);
                }}
              >
                Remove them
              </Button>
            </>
          }
        >
          <p>
            These never made it into your backup, so removing them takes nothing out of storage — they just
            stop showing in My Files.
            {removing.counts.stored > 0 ? ` The ${plural(removing.counts.stored, "file")} that did upload stay put.` : ""}
          </p>
          <p>If you want them backed up later, drop the folder in again.</p>
        </Modal>
      )}
    </Page>
  );
};
