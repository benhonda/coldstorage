/**
 * My Files — the front door and the whole drive. A reorganizable filesystem you browse like an external
 * drive: drill-in folders, per-file status badges, drop-to-upload as the hero gesture, Finder-style
 * reorganize, and request-back.
 *
 * Holds no upload logic. The tree comes from {@link useFiles} (the daemon's journal-backed `listFiles`);
 * request-back issues the real `restore` command via `exec`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ColdstoreApi, ConflictPolicy, DepositPreviewItem, RetrievalQuote } from "../../../shared/ipc.ts";
import type { Exec } from "./types.ts";
import type { FilesApi } from "./files/useFiles.ts";
import type { RunProgress } from "../state/reducer.ts";
import { DepositProgress } from "./DepositProgress.tsx";
import {
  type ArchivedFile,
  type Row,
  type RowTarget,
  baseName,
  childrenOf,
  filesUnder,
  formatBytes,
  formatDate,
  isEmptyFolder,
  joinPath,
  parentOf,
  planDeposit,
  reparent,
  rowKey,
  rowStatus,
  targetOf,
  totalBytes,
  withName,
  type UploadProgress,
  uploadPercent,
} from "./files/model.ts";
import { Breadcrumb } from "./files/Breadcrumb.tsx";
import { CollisionModal } from "./files/CollisionModal.tsx";
import { ContextMenu, type MenuEntry } from "./files/ContextMenu.tsx";
import { FolderTree } from "./files/FolderTree.tsx";
import { InfoModal, type SelectionSummary } from "./files/InfoModal.tsx";
import { RequestBackModal } from "./files/RequestBackModal.tsx";
import { KindIcon, StatusIcon } from "./files/StatusBadge.tsx";
import { Button, IconButton, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";

interface Props {
  api: ColdstoreApi;
  exec: Exec;
  files: ArchivedFile[];
  virtualFolders: string[];
  filesApi: FilesApi;
  /** Live per-file upload progress (store `run.uploadProgress`), keyed by daemon file id — drives the
   * determinate bar on an uploading row. Empty between runs. */
  uploadProgress: Record<string, UploadProgress>;
  /** The whole run, for the aggregate deposit banner at the top of the browser (files done, bytes,
   * throughput, ETA). `null` when no run has happened yet. */
  run: RunProgress | null;
  /** Whether NEW deposits are allowed (Phase 5c). False = signed in but no active subscription; a deposit
   * attempt calls {@link onDepositBlocked} (→ the paywall) instead of uploading. True in dogfood mode. */
  canDeposit: boolean;
  onDepositBlocked: () => void;
}

type ViewMode = "list" | "grid";
interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

export const MyFilesView = ({
  api,
  exec,
  files,
  virtualFolders,
  filesApi,
  uploadProgress,
  run,
  canDeposit,
  onDepositBlocked,
}: Props): React.JSX.Element => {
  const [dir, setDir] = useState("");
  const [view, setView] = useState<ViewMode>("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [requestFiles, setRequestFiles] = useState<ArchivedFile[] | null>(null);
  /** The backend's price for the pending request (null while it's still being fetched). The renderer never
   *  computes a restore price — see RequestBackModal's note on why the old local estimate was ~40× wrong. */
  const [quote, setQuote] = useState<RetrievalQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RowTarget[] | null>(null);
  const [moveTargets, setMoveTargets] = useState<RowTarget[] | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  // Finder-style deposit collision prompt. Promise-bridged: `promptCollisions` opens the modal and resolves
  // when the user picks (a policy map) or cancels (null), so the deposit flow can `await` the decision.
  const [collision, setCollision] = useState<{
    folderName: string;
    collisions: string[];
    resolve: (policies: Record<string, ConflictPolicy> | null) => void;
  } | null>(null);

  const dragDepth = useRef(0);
  const lastIndex = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => childrenOf(files, dir, virtualFolders), [files, dir, virtualFolders]);

  // Determinate upload % for a file row (null → fall back to the indeterminate bar). Folders roll up many
  // files, so they keep the indeterminate stripe rather than picking one file's %.
  const uploadPct = (row: Row): number | null =>
    row.type === "file" ? uploadPercent(uploadProgress, row.file) : null;

  // ── navigation resets transient state ──
  const goTo = (next: string): void => {
    setDir(next);
    setSelected(new Set());
    setRenaming(null);
    lastIndex.current = null;
  };

  // ── selection ──
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)));

  const onRowClick = (e: React.MouseEvent, row: Row, index: number): void => {
    const key = rowKey(row);
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      next.has(key) ? next.delete(key) : next.add(key);
      setSelected(next);
    } else if (e.shiftKey && lastIndex.current !== null) {
      const lo = Math.min(lastIndex.current, index);
      const hi = Math.max(lastIndex.current, index);
      setSelected(new Set(rows.slice(lo, hi + 1).map(rowKey)));
    } else {
      setSelected(new Set([key]));
    }
    lastIndex.current = index;
  };

  const openRow = (row: Row): void => {
    if (row.type === "folder") return goTo(row.path);
    setSelected(new Set([rowKey(row)])); // double-click a file → Get info (not retrieve)
    setInfoOpen(true);
  };

  // ── concrete files a target set covers (folders expanded, deduped) ──
  const filesForTargets = (targets: RowTarget[]): ArchivedFile[] => {
    const seen = new Set<string>();
    const out: ArchivedFile[] = [];
    for (const t of targets) {
      const covered = t.kind === "file" ? files.filter((f) => f.id === t.id) : filesUnder(files, t.path);
      for (const f of covered) if (!seen.has(f.id)) (seen.add(f.id), out.push(f));
    }
    return out;
  };

  // ── request back: price it, take payment if it isn't free, then issue the REAL restore ──
  //
  // A restore is a HARD-gated, priced operation now (root RETRIEVAL.md): the daemon holds no
  // `s3:RestoreObject`, so the blobs cannot thaw until the backend says this restore is paid for (or free
  // under the monthly allowance) and thaws them itself. Hence the order here — quote, pay, THEN restore.
  // Issuing `restore` first would just get `authorizationRequired` back and strand the user.
  const openRequest = (candidates: ArchivedFile[]): void => {
    const restorable = candidates.filter((f) => f.status === "frozen");
    if (restorable.length === 0) return;
    setRequestFiles(restorable);
    setQuote(null);
    setQuoteError(null);

    // Ask the DAEMON which blobs this needs (it dedupes — many files usually share one blob, and a blob
    // is thawed and billed once), then ask the BACKEND what that costs. The renderer prices nothing.
    void (async () => {
      try {
        const plan = await api.request("restorePlan", { files: restorable.map((f) => f.id).join("\n") });
        setQuote(await api.quoteRestore(plan.blobKeys, plan.egressBytes));
      } catch (e) {
        setQuoteError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const confirmRequest = (folder: string): void => {
    const files = requestFiles ?? [];
    const job = quote;
    setRequestFiles(null);
    if (!job) return; // never start a transfer we couldn't price — the button is disabled, but be certain

    void (async () => {
      // Pay first when there's something to pay. `payForRestore` resolves only once the webhook confirms
      // the money AND the backend has begun thawing — so by the time we issue `restore`, the daemon will
      // find the blobs thawing rather than frozen. A free (allowance-covered) job is already authorized at
      // quote time, so it skips straight through.
      if (job.quoteCents > 0) {
        try {
          await api.payForRestore(job.jobId);
        } catch (e) {
          setQuoteError(e instanceof Error ? e.message : String(e));
          return; // payment didn't land — don't pretend a restore started
        }
      }
      for (const f of files) {
        const out = `${folder}/${baseName(f.relativePath)}`;
        exec(() => api.request("restore", { file: f.id, out }));
      }
    })();
  };

  // ── reorganize ──
  const startRename = (key: string): void => {
    setSelected(new Set([key]));
    setRenaming(key);
  };
  // Rename = a move to a sibling path. Optimistic edit for instant feedback, then the REAL daemon
  // `movePath` (a cheap journal relativePath edit); its `filesChanged` event reconciles the tree.
  const commitRename = (row: Row, value: string): void => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== row.name) {
      const target = targetOf(row);
      const to = withName(target.path, trimmed);
      filesApi.rename(target, trimmed);
      exec(() => api.request("movePath", { from: target.path, to }));
    }
    setRenaming(null);
  };
  // New folder = an optimistic empty-folder row (instant inline-rename) + the REAL daemon `createFolder`,
  // which writes a journal marker so the folder PERSISTS across a reload. Its `filesChanged` event
  // reconciles the tree. The subsequent rename is a `movePath` (commitRename), which sweeps the marker too.
  const doNewFolder = (): void => {
    const path = filesApi.newFolder(dir);
    exec(() => api.request("createFolder", { path }));
    startRename(`folder:${path}`);
  };
  // Delete = tombstone each target's subtree in the journal (bytes aren't reclaimed — deferred repack/GC).
  // Optimistic drop from the tree, then the REAL daemon `deletePath` per target.
  const doDelete = (targets: RowTarget[]): void => {
    filesApi.remove(targets);
    exec(() => Promise.all(targets.map((t) => api.request("deletePath", { path: t.path }))));
    setSelected(new Set());
    setConfirmDelete(null);
  };
  // Confirm only when there are real uploaded bytes at stake; an empty folder just goes.
  const requestDelete = (targets: RowTarget[]): void => {
    if (filesForTargets(targets).length > 0) setConfirmDelete(targets);
    else doDelete(targets);
  };
  const clearSelection = (): void => setSelected(new Set());
  // Move each target's subtree under `toDir`. Optimistic re-parent, then the REAL daemon `movePath` per
  // target ({ from: full path, to: toDir/basename }); `filesChanged` reconciles to journal truth.
  const doMove = (toDir: string): void => {
    if (moveTargets) {
      const targets = moveTargets;
      filesApi.move(targets, toDir);
      exec(() => Promise.all(targets.map((t) => api.request("movePath", { from: t.path, to: reparent(t.path, toDir) }))));
    }
    setSelected(new Set());
    setMoveTargets(null);
  };

  // ── context menu ──
  const openMenu = (e: React.MouseEvent, row?: Row): void => {
    e.preventDefault();
    e.stopPropagation();
    // right-clicking an unselected row selects just it, so the menu acts on what was clicked
    let targets: RowTarget[];
    let single: Row | null;
    if (row && !selected.has(rowKey(row))) {
      setSelected(new Set([rowKey(row)]));
      targets = [targetOf(row)];
      single = row;
    } else {
      const sr = rows.filter((r) => selected.has(rowKey(r)));
      targets = sr.map(targetOf);
      single = sr.length === 1 ? (sr[0] ?? null) : null;
    }

    const restorable = filesForTargets(targets).filter((f) => f.status === "frozen");
    // a single failed upload we still hold the source path for → offer Retry at the top
    const retryable = single?.type === "file" && single.file.status === "failed" && single.file.srcPath ? single.file : null;
    const items: MenuEntry[] = targets.length
      ? [
          ...(retryable
            ? ([{ label: "Retry upload", icon: "refresh", onClick: () => retryDeposit(retryable) }, "separator"] as MenuEntry[])
            : []),
          { label: "Get info", icon: "info", onClick: () => setInfoOpen(true), disabled: !single },
          { label: "Rename", icon: "edit", onClick: () => single && startRename(rowKey(single)), disabled: !single },
          { label: "Move to…", icon: "drive_file_move", onClick: () => setMoveTargets(targets) },
          { label: "New folder", icon: "create_new_folder", onClick: doNewFolder },
          "separator",
          { label: "Request a copy…", icon: "download", onClick: () => openRequest(filesForTargets(targets)), disabled: restorable.length === 0 },
          { label: "Delete", icon: "delete", danger: true, onClick: () => requestDelete(targets) },
        ]
      : [
          { label: "Upload files…", icon: "upload", onClick: () => fileInput.current?.click() },
          { label: "Add photos…", icon: "photo_library", onClick: addPhotos },
          { label: "New folder", icon: "create_new_folder", onClick: doNewFolder },
        ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ── deposit (hero) — REAL drop-to-upload ──
  // Optimistic "uploading" rows give instant feedback; the daemon's `deposit` command does the actual
  // ingest. Its runStarted/fileArchived/blobFailed/runFinished events drive the truth — on runFinished
  // the controller refetches listFiles and the optimistic rows are replaced by the real archived files
  // (✓ stored) or, on failure, surface in the "couldn't upload" panel. Paths are resolved in the preload
  // (webUtils.getPathForFile — Electron 32+ removed File.path).
  // Open the collision prompt and resolve when the user decides (policy map) or cancels (null).
  const promptCollisions = (folderName: string, collisions: string[]): Promise<Record<string, ConflictPolicy> | null> =>
    new Promise((resolve) => setCollision({ folderName, collisions, resolve }));

  // The shared deposit pipeline for BOTH a file drop and a photo pick: preview placement (which target
  // names already exist) → prompt the user on any collisions (Keep Both / Replace / Skip) → add optimistic
  // rows for what will actually land → issue the real deposit with the chosen resolutions. The daemon's
  // runStarted→fileArchived→runFinished events then refetch listFiles and reconcile to journal truth.
  // Rethrows on command rejection so `exec` (at the call site) surfaces the toast. `fallback` seeds the
  // preview when the daemon can't dry-run it (off-Mac / resolver hiccup) so the deposit still proceeds.
  const runDeposit = async (opts: {
    kind: "files" | "photos";
    wire: string; // newline-joined absolute paths (files) or Photos localIdentifiers (photos)
    dest: string;
    srcByBase: Map<string, string>; // basename → local srcPath (files only) so a failed upload can retry
    fallback: string[]; // target relativePaths to assume if preview is unavailable
  }): Promise<void> => {
    // Subscription gate (Phase 5c): backing up NEW files needs an active sub. Bail to the paywall before
    // any preview/optimistic rows so a blocked drop leaves the tree untouched.
    if (!canDeposit) {
      onDepositBlocked();
      return;
    }
    let preview: DepositPreviewItem[];
    try {
      preview = await api.request(
        "previewDeposit",
        opts.kind === "files" ? { dest: opts.dest, src: opts.wire } : { dest: opts.dest, assetIds: opts.wire },
      );
    } catch {
      preview = opts.fallback.map((relativePath) => ({ relativePath, exists: false }));
    }
    const collisions = preview.filter((p) => p.exists).map((p) => p.relativePath);
    let policies: Record<string, ConflictPolicy> = {};
    if (collisions.length > 0) {
      const chosen = await promptCollisions(opts.dest, collisions);
      if (!chosen) return; // cancelled → abort the whole drop, no upload
      policies = chosen;
    }
    const { rows, conflicts } = planDeposit(preview, policies, new Set(files.map((f) => f.relativePath)));
    // Optimistic "uploading" rows for what will land — names carry their full vault path (so intoDir is "").
    const optimisticIds = filesApi.deposit(
      rows.map((r) => {
        const srcPath = opts.srcByBase.get(baseName(r.original));
        return srcPath ? { name: r.relativePath, srcPath } : { name: r.relativePath };
      }),
      "",
    );
    // Only attach `conflicts` when there's something to resolve (exactOptionalPropertyTypes — omit, don't undefined).
    const extra = Object.keys(conflicts).length > 0 ? { conflicts: JSON.stringify(conflicts) } : {};
    const sent =
      opts.kind === "files"
        ? api.request("deposit", { src: opts.wire, dest: opts.dest, ...extra })
        : api.request("depositPhotos", { assetIds: opts.wire, dest: opts.dest, ...extra });
    await sent.catch((e: unknown) => {
      filesApi.setDepositStatus(optimisticIds, "failed"); // command rejected → ⚠ on the rows, don't strand them
      throw e;
    });
  };

  // ── deposit (hero) — REAL drop-to-upload ──
  const depositFiles = (dropped: File[]): void => {
    if (dropped.length === 0) return;
    const items = dropped.map((f) => ({ name: f.name, srcPath: api.pathForFile(f) }));
    const paths = items.map((i) => i.srcPath).filter(Boolean);
    if (paths.length === 0) {
      // Couldn't resolve any local paths → show ⚠ rows rather than vanishing.
      const ids = filesApi.deposit(items.map((i) => ({ name: i.name })), dir);
      filesApi.setDepositStatus(ids, "failed");
      return;
    }
    const srcByBase = new Map(items.filter((i) => i.srcPath).map((i) => [i.name, i.srcPath]));
    exec(() =>
      runDeposit({
        kind: "files",
        wire: paths.join("\n"),
        dest: dir,
        srcByBase,
        fallback: items.map((i) => joinPath(dir, i.name)),
      }),
    );
  };
  // Retry a failed upload: flip the row back to uploading and re-issue its deposit (we kept its srcPath).
  // No preview/prompt — a retry targets the same path it already owns (overwrite-self is a no-op upsert).
  const retryDeposit = (file: ArchivedFile): void => {
    if (!file.srcPath) return;
    if (!canDeposit) {
      onDepositBlocked();
      return;
    }
    const srcPath = file.srcPath;
    filesApi.setDepositStatus([file.id], "uploading");
    exec(() =>
      api.request("deposit", { src: srcPath, dest: parentOf(file.relativePath) }).catch((e: unknown) => {
        filesApi.setDepositStatus([file.id], "failed");
        throw e;
      }),
    );
  };
  // ── add photos (native picker) — REAL explicit photo deposit (option B) ──
  // The native macOS Photos picker (a separate helper) returns PHAsset localIdentifiers; the daemon
  // resolves them to full-res originals (incl. iCloud download). Same collision handling as a file drop —
  // previewDeposit resolves the true filenames so re-picking a photo already in this folder prompts rather
  // than silently colliding. Cancel / pick-nothing is a no-op (the helper returns []).
  const addPhotos = (): void => {
    exec(async () => {
      const picks = await api.pickPhotos();
      if (picks.length === 0) return; // cancelled / nothing picked
      await runDeposit({
        kind: "photos",
        wire: picks.map((p) => p.id).join("\n"),
        dest: dir,
        srcByBase: new Map(),
        fallback: picks.map((p) => joinPath(dir, p.name)),
      });
    });
  };
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    depositFiles([...e.dataTransfer.files]);
  };
  const onDragEnter = (e: React.DragEvent): void => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    dragDepth.current += 1;
    setDropActive(true);
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  };

  // SEAM: `Show in Finder` needs a main-process reveal (shell.showItemInFolder via IPC) — polish item.
  const onOpen = (_file: ArchivedFile): void => {};

  // Keyboard: Escape closes the detail view (deselect); Delete/Backspace removes the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (document.activeElement instanceof HTMLInputElement) return; // don't hijack rename/typing
      if (e.key === "Escape") {
        clearSelection();
        setRenaming(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const sr = rows.filter((r) => selected.has(rowKey(r)));
        if (sr.length > 0) {
          e.preventDefault();
          requestDelete(sr.map(targetOf));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected, files]);

  // ── selection summary — drives the Get-info modal + menu enablement ──
  const sel: SelectionSummary | null = (() => {
    if (selectedRows.length === 0) return null;
    const concrete = filesForTargets(selectedRows.map(targetOf));
    const only = selectedRows.length === 1 ? (selectedRows[0] ?? null) : null;
    return {
      file: only?.type === "file" ? only.file : null,
      folder: only?.type === "folder" ? { name: only.name, count: only.count } : null,
      items: selectedRows.length,
      count: concrete.length,
      bytes: totalBytes(concrete),
      restorable: concrete.filter((f) => f.status === "frozen"),
    };
  })();

  const actions = (
    <>
      <div className="cs-seg" role="group" aria-label="View">
        <button type="button" className="cs-seg-btn" aria-pressed={view === "list"} aria-label="List view" onClick={() => setView("list")}>
          <Icon name="view_list" size={20} />
        </button>
        <button type="button" className="cs-seg-btn" aria-pressed={view === "grid"} aria-label="Grid view" onClick={() => setView("grid")}>
          <Icon name="grid_view" size={20} />
        </button>
      </div>
      <IconButton icon="create_new_folder" label="New folder" onClick={doNewFolder} />
      <Button variant="primary" icon="add" onClick={() => fileInput.current?.click()}>
        Add
      </Button>
    </>
  );

  return (
    <Page title={<Breadcrumb dir={dir} onNavigate={goTo} />} actions={actions} fill>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          depositFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <div
        className="cs-browser"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={onDrop}
      >
        <div
          className="cs-browser-main"
          onClick={(e) => e.target === e.currentTarget && clearSelection()}
          onContextMenu={(e) => e.target === e.currentTarget && openMenu(e)}
        >
          <DepositProgress run={run} />
          {/* FirstRun (the drop-zone hero) is the onboarding state for a genuinely empty vault — root with
              nothing in it. A drilled-into empty folder just shows the empty file list, not the hero. */}
          {rows.length === 0 && dir === "" ? (
            <FirstRun onChoose={() => fileInput.current?.click()} onContextMenu={openMenu} />
          ) : view === "list" ? (
            <FileList
              rows={rows}
              selected={selected}
              renaming={renaming}
              uploadPct={uploadPct}
              onRowClick={onRowClick}
              onRowOpen={openRow}
              onRowContext={openMenu}
              onStartRename={(row) => startRename(rowKey(row))}
              onCommitRename={commitRename}
              onCancelRename={() => setRenaming(null)}
              onClearSelection={clearSelection}
            />
          ) : (
            <Gallery
              rows={rows}
              selected={selected}
              onRowClick={onRowClick}
              onRowOpen={openRow}
              onRowContext={openMenu}
              onClearSelection={clearSelection}
            />
          )}
          {!(rows.length === 0 && dir === "") && (
            <p className="cs-hint">drop anywhere to upload · right-click for more</p>
          )}
        </div>

        {dropActive && (
          <div className="cs-drop">
            <div className="cs-drop-inner">
              <Icon name="cloud_upload" />
              <span className="cs-drop-title">Drop to upload</span>
            </div>
          </div>
        )}
      </div>

      {infoOpen && sel && (
        <InfoModal
          sel={sel}
          onDownload={() => {
            setInfoOpen(false);
            openRequest(sel.restorable);
          }}
          onShowInFinder={onOpen}
          onClose={() => setInfoOpen(false)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {requestFiles && (
        <RequestBackModal
          files={requestFiles}
          quote={quote}
          quoteError={quoteError}
          chooseFolder={api.chooseFolder}
          getDownloadsDir={api.getDownloadsDir}
          onConfirm={confirmRequest}
          onClose={() => {
            // Let go of an unpaid quote so it burns none of the user's free monthly allowance.
            if (quote && quote.quoteCents > 0) void api.cancelRestore(quote.jobId);
            setRequestFiles(null);
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          title="Delete from your files?"
          icon="delete"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Keep
              </Button>
              <Button variant="danger" icon="delete" onClick={() => doDelete(confirmDelete)}>
                Delete
              </Button>
            </>
          }
        >
          <p className="cs-quote-lead">
            This removes {confirmDelete.length === 1 ? "it" : `${confirmDelete.length} items`} from your
            files. It doesn't lower your cost for 180 days — deep storage has a minimum keep time.
          </p>
        </Modal>
      )}

      {moveTargets && (
        <MoveModal
          files={files}
          virtualFolders={virtualFolders}
          targets={moveTargets}
          onMove={doMove}
          onClose={() => setMoveTargets(null)}
        />
      )}

      {collision && (
        <CollisionModal
          folderName={baseName(collision.folderName)}
          collisions={collision.collisions}
          onConfirm={(policies) => {
            collision.resolve(policies);
            setCollision(null);
          }}
          onClose={() => {
            collision.resolve(null); // cancel → abort the deposit
            setCollision(null);
          }}
        />
      )}
    </Page>
  );
};

// ── list view ──────────────────────────────────────────────────────

// Rename is a deliberate gesture, never a plain double-click (double-click OPENS the row — folder drills
// in, file shows Get-info). Like macOS/iOS: press-and-hold the name to rename; or use the ⋯ / right-click
// menu. A hold this long can't be confused with a click or a double-click (both release immediately).
const RENAME_LONG_PRESS_MS = 500;
// A pointer drift past this (px) cancels the press — it was a drag/scroll, not a hold-to-rename.
const PRESS_DRIFT_PX = 8;

const FileList = ({
  rows,
  selected,
  renaming,
  uploadPct,
  onRowClick,
  onRowOpen,
  onRowContext,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onClearSelection,
}: {
  rows: Row[];
  selected: Set<string>;
  renaming: string | null;
  uploadPct: (row: Row) => number | null;
  onRowClick: (e: React.MouseEvent, row: Row, index: number) => void;
  onRowOpen: (row: Row) => void;
  /** Right-click handler — pass a row for a row menu, omit it for the empty-area (Upload / New folder) menu. */
  onRowContext: (e: React.MouseEvent, row?: Row) => void;
  onStartRename: (row: Row) => void;
  onCommitRename: (row: Row, value: string) => void;
  onCancelRename: () => void;
  onClearSelection: () => void;
}): React.JSX.Element => {
  // One shared press timer (only one name is held at a time). Held in refs so re-renders don't reset it.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = (): void => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressOrigin.current = null;
  };
  const startPress = (e: React.PointerEvent, row: Row): void => {
    if (e.button !== 0) return; // left button / primary touch only
    cancelPress();
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = setTimeout(() => {
      cancelPress();
      onStartRename(row);
    }, RENAME_LONG_PRESS_MS);
  };
  const trackPress = (e: React.PointerEvent): void => {
    const o = pressOrigin.current;
    if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > PRESS_DRIFT_PX) cancelPress();
  };

  return (
  // Finder-style: a click that lands on the list's blank area (the card itself, not a row) clears the
  // selection; a right-click there opens the empty-area menu. Row events bubble here too, but
  // target!==currentTarget for them, so they don't deselect / double-fire.
  <div
    className="cs-filelist"
    onClick={(e) => e.target === e.currentTarget && onClearSelection()}
    onContextMenu={(e) => e.target === e.currentTarget && onRowContext(e)}
  >
    <div className="cs-fl-grid cs-fl-head">
      <span>Name</span>
      <span>Size</span>
      <span>Date</span>
      <span />
    </div>
    {rows.map((row, i) => {
      const key = rowKey(row);
      const isFolder = row.type === "folder";
      const status = rowStatus(row);
      const pct = status === "uploading" ? uploadPct(row) : null;
      return (
        <div
          key={key}
          className="cs-fl-grid cs-fl-row"
          role="row"
          aria-selected={selected.has(key)}
          onClick={(e) => onRowClick(e, row, i)}
          onDoubleClick={() => onRowOpen(row)}
          onContextMenu={(e) => onRowContext(e, row)}
        >
          <span className={isFolder ? "cs-fl-name cs-fl-folder" : "cs-fl-name"}>
            {isFolder ? <Icon name="folder" size={22} /> : <KindIcon kind={row.file.kind} />}
            {renaming === key ? (
              <RenameInput initial={row.name} onCommit={(v) => onCommitRename(row, v)} onCancel={onCancelRename} />
            ) : (
              <span
                className="cs-fl-label"
                title={row.name}
                onPointerDown={(e) => startPress(e, row)}
                onPointerMove={trackPress}
                onPointerUp={cancelPress}
                onPointerLeave={cancelPress}
              >
                {row.name}
              </span>
            )}
          </span>
          <span className="cs-fl-size">{row.type === "folder" ? (row.empty ? "—" : formatBytes(row.size)) : formatBytes(row.file.size)}</span>
          <span className="cs-fl-date">{row.type === "file" ? formatDate(row.file.date) : `${row.count} items`}</span>
          <span className="cs-fl-actions">
            {/* status icon by the ⋯: ✓ stored · ↑ uploading · ⚠ couldn't upload · ↓ transferring · saved-here.
                An empty folder has nothing stored, so it shows no badge. */}
            {!isEmptyFolder(row) && <StatusIcon status={status} />}
            <IconButton
              icon="more_horiz"
              label="Actions"
              className="cs-fl-more"
              onClick={(e) => {
                e.stopPropagation();
                onRowContext(e, row);
              }}
            />
          </span>
          {/* activity indicator under the row: a DETERMINATE 0–100 fill when the daemon reports per-file
              byte progress (`uploadProgress`, large solo-blob files), else an INDETERMINATE stripe that
              just says "working" (small batched files / before the first progress event). */}
          {status === "uploading" &&
            (pct === null ? (
              <span className="cs-uploading-bar" aria-hidden="true" />
            ) : (
              <span
                className="cs-uploading-bar cs-uploading-bar--determinate"
                style={{ "--pct": `${pct}%` } as React.CSSProperties}
                aria-hidden="true"
              />
            ))}
        </div>
      );
    })}
    {/* striped filler so the zebra reads continuously into the empty space below the last row (and fills
        the body of an empty folder). Shift by one band when the row count is odd so parity continues. */}
    <div
      className="cs-fl-filler"
      aria-hidden="true"
      onClick={onClearSelection}
      onContextMenu={(e) => onRowContext(e)}
      style={{ "--fill-shift": rows.length % 2 === 0 ? "0px" : "var(--cs-row-h)" } as React.CSSProperties}
    />
  </div>
  );
};

const RenameInput = ({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}): React.JSX.Element => {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // focus AND select the whole name on mount so it's highlighted, ready to replace (Finder "new folder" behaviour)
  useEffect(() => inputRef.current?.select(), []);
  return (
    <input
      ref={inputRef}
      className="cs-fl-rename"
      autoFocus
      value={value}
      onClick={(e) => e.stopPropagation()}
      // double-click selects a word in the field; don't let it bubble to the row (which would drill in / open).
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
    />
  );
};

// ── grid / gallery view ────────────────────────────────────────────

const Gallery = ({
  rows,
  selected,
  onRowClick,
  onRowOpen,
  onRowContext,
  onClearSelection,
}: {
  rows: Row[];
  selected: Set<string>;
  onRowClick: (e: React.MouseEvent, row: Row, index: number) => void;
  onRowOpen: (row: Row) => void;
  /** Right-click handler — pass a tile's row for a row menu, omit it for the empty-area menu. */
  onRowContext: (e: React.MouseEvent, row?: Row) => void;
  onClearSelection: () => void;
}): React.JSX.Element => (
  // click / right-click on the blank grid area (not a tile) clears the selection / opens the empty menu
  <div
    className="cs-gallery"
    onClick={(e) => e.target === e.currentTarget && onClearSelection()}
    onContextMenu={(e) => e.target === e.currentTarget && onRowContext(e)}
  >
    {rows.map((row, i) => {
      const key = rowKey(row);
      return (
        <button
          key={key}
          type="button"
          className="cs-tile"
          aria-selected={selected.has(key)}
          onClick={(e) => onRowClick(e, row, i)}
          onDoubleClick={() => onRowOpen(row)}
          onContextMenu={(e) => onRowContext(e, row)}
        >
          {/* file-type icon today; a real thumbnail when R2 lands (the only R2-gated piece) */}
          <span className="cs-tile-thumb">{row.type === "folder" ? <Icon name="folder" size={40} /> : <KindIcon kind={row.file.kind} size={40} />}</span>
          <span className="cs-tile-foot">
            <span className="cs-tile-name" title={row.name}>{row.name}</span>
            {!isEmptyFolder(row) && <StatusIcon status={rowStatus(row)} />}
          </span>
        </button>
      );
    })}
  </div>
);

// ── first run / empty folder ───────────────────────────────────────

const FirstRun = ({
  onChoose,
  onContextMenu,
}: {
  onChoose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}): React.JSX.Element => (
  <button type="button" className="cs-firstrun" onClick={onChoose} onContextMenu={onContextMenu}>
    <span className="cs-dropzone-badge">
      <Icon name="cloud_upload" size={38} />
    </span>
    <span className="cs-dropzone-title">Drop files or folders to upload</span>
    <span className="cs-dropzone-sub">
      or click to choose. They&apos;re encrypted on your Mac before upload.
    </span>
    <span className="cs-btn cs-btn--primary cs-dropzone-cta">
      <Icon name="add" size={20} />
      Choose files
    </span>
  </button>
);

// ── move-to folder picker ──────────────────────────────────────────

const MoveModal = ({
  files,
  virtualFolders,
  targets,
  onMove,
  onClose,
}: {
  files: ArchivedFile[];
  virtualFolders: string[];
  targets: RowTarget[];
  onMove: (toDir: string) => void;
  onClose: () => void;
}): React.JSX.Element => {
  // Can't move a folder into itself or its own subtree.
  const moved = new Set(targets.filter((t) => t.kind === "folder").map((t) => t.path));
  const blocked = (p: string): boolean => [...moved].some((m) => p === m || p.startsWith(`${m}/`));
  const [dest, setDest] = useState("");
  return (
    <Modal
      title={`Move ${targets.length === 1 ? "1 item" : `${targets.length} items`} to…`}
      icon="drive_file_move"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="check" disabled={blocked(dest)} onClick={() => onMove(dest)}>
            Move here
          </Button>
        </>
      }
    >
      <FolderTree files={files} virtualFolders={virtualFolders} value={dest} onChange={setDest} isDisabled={blocked} />
    </Modal>
  );
};
