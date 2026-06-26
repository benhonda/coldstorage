/**
 * My Files — the front door and the whole drive. A reorganizable filesystem you browse like an external
 * drive: drill-in folders, per-file status badges, drop-to-upload as the hero gesture, Finder-style
 * reorganize, and request-back.
 *
 * Holds no upload logic. The tree comes from {@link useFiles} (the daemon's journal-backed `listFiles`);
 * request-back issues the real `restore` command via `exec`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ColdstoreApi, Pricing } from "../../../shared/ipc.ts";
import type { Exec } from "./types.ts";
import type { FilesApi } from "./files/useFiles.ts";
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
  parentOf,
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
  /** Rate card (store `state.pricing`) — drives the request-a-copy fee quote. */
  pricing: Pricing;
  /** Live per-file upload progress (store `run.uploadProgress`), keyed by daemon file id — drives the
   * determinate bar on an uploading row. Empty between runs. */
  uploadProgress: Record<string, UploadProgress>;
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
  pricing,
  uploadProgress,
}: Props): React.JSX.Element => {
  const [dir, setDir] = useState("");
  const [view, setView] = useState<ViewMode>("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [requestFiles, setRequestFiles] = useState<ArchivedFile[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RowTarget[] | null>(null);
  const [moveTargets, setMoveTargets] = useState<RowTarget[] | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);

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

  // ── request back: issue the REAL restore command per frozen file ──
  const openRequest = (candidates: ArchivedFile[]): void => {
    const restorable = candidates.filter((f) => f.status === "frozen");
    if (restorable.length > 0) setRequestFiles(restorable);
  };
  const confirmRequest = (folder: string): void => {
    for (const f of requestFiles ?? []) {
      const out = `${folder}/${baseName(f.relativePath)}`;
      exec(() => api.request("restore", { file: f.id, out }));
    }
    setRequestFiles(null);
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
  const depositFiles = (files: File[]): void => {
    if (files.length === 0) return;
    const items = files.map((f) => ({ name: f.name, srcPath: api.pathForFile(f) }));
    const optimisticIds = filesApi.deposit(items, dir); // instant "uploading" feedback; rows carry srcPath
    const paths = items.map((i) => i.srcPath).filter(Boolean);
    if (paths.length === 0) {
      filesApi.setDepositStatus(optimisticIds, "failed"); // couldn't resolve paths → show ⚠, don't vanish
      return;
    }
    issueDeposit(paths, dir, optimisticIds);
  };
  // Issue the real deposit; on command rejection flip rows to ⚠ failed (failure stays ON the file) and
  // rethrow so `exec` surfaces the toast. (A failure of the actual upload arrives later as blobFailed.)
  const issueDeposit = (paths: string[], dest: string, ids: string[]): void => {
    exec(() =>
      api.request("deposit", { src: paths.join("\n"), dest }).catch((e: unknown) => {
        filesApi.setDepositStatus(ids, "failed");
        throw e;
      }),
    );
  };
  // Retry a failed upload: flip the row back to uploading and re-issue its deposit (we kept its srcPath).
  const retryDeposit = (file: ArchivedFile): void => {
    if (!file.srcPath) return;
    filesApi.setDepositStatus([file.id], "uploading");
    issueDeposit([file.srcPath], parentOf(file.relativePath), [file.id]);
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
          pricing={pricing}
          chooseFolder={api.chooseFolder}
          getDownloadsDir={api.getDownloadsDir}
          onConfirm={confirmRequest}
          onClose={() => setRequestFiles(null)}
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
            <span className="cs-tile-name">{row.name}</span>
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
