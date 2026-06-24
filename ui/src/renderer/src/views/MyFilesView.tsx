/**
 * My Files — the front door and the whole drive. A reorganizable filesystem you browse like an external
 * drive: drill-in folders, per-file status badges, drop-to-upload as the hero gesture, Finder-style
 * reorganize, and request-back.
 *
 * Holds no upload logic. The tree comes from {@link useFiles} (journal-backed; fixtures until the
 * daemon's `listFiles` lands); request-back issues the real `restore` command via `exec`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ColdstoreApi } from "../../../shared/ipc.ts";
import type { Exec } from "./types.ts";
import type { FilesApi } from "./files/useFiles.ts";
import {
  type ArchivedFile,
  type Row,
  type RowTarget,
  allFolderPaths,
  baseName,
  childrenOf,
  filesUnder,
  formatBytes,
  formatDate,
  rowKey,
  rowStatus,
  targetOf,
  totalBytes,
} from "./files/model.ts";
import { Breadcrumb } from "./files/Breadcrumb.tsx";
import { ContextMenu, type MenuEntry } from "./files/ContextMenu.tsx";
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
  const commitRename = (row: Row, value: string): void => {
    if (value.trim() && value.trim() !== row.name) filesApi.rename(targetOf(row), value.trim());
    setRenaming(null);
  };
  const doNewFolder = (): void => {
    const path = filesApi.newFolder(dir);
    startRename(`folder:${path}`);
  };
  const doDelete = (targets: RowTarget[]): void => {
    filesApi.remove(targets);
    setSelected(new Set());
    setConfirmDelete(null);
  };
  // Confirm only when there are real uploaded bytes at stake; an empty folder just goes.
  const requestDelete = (targets: RowTarget[]): void => {
    if (filesForTargets(targets).length > 0) setConfirmDelete(targets);
    else doDelete(targets);
  };
  const clearSelection = (): void => setSelected(new Set());
  const doMove = (toDir: string): void => {
    if (moveTargets) filesApi.move(moveTargets, toDir);
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
    const items: MenuEntry[] = targets.length
      ? [
          { label: "Get info", icon: "info", onClick: () => setInfoOpen(true), disabled: !single },
          { label: "Rename", icon: "edit", onClick: () => single && startRename(rowKey(single)), disabled: !single },
          { label: "Move to…", icon: "drive_file_move", onClick: () => setMoveTargets(targets) },
          { label: "New folder", icon: "create_new_folder", onClick: doNewFolder },
          "separator",
          { label: "Request a copy…", icon: "download", onClick: () => openRequest(filesForTargets(targets)), disabled: restorable.length === 0 },
          { label: "Delete", icon: "delete", danger: true, onClick: () => requestDelete(targets) },
        ]
      : [{ label: "New folder", icon: "create_new_folder", onClick: doNewFolder }];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ── deposit (hero) ──
  const depositNames = (names: string[]): void => {
    if (names.length) filesApi.deposit(names, dir);
  };
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    depositNames([...e.dataTransfer.files].map((f) => f.name));
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
          depositNames([...(e.target.files ?? [])].map((f) => f.name));
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
          {rows.length === 0 ? (
            <FirstRun />
          ) : view === "list" ? (
            <FileList
              rows={rows}
              selected={selected}
              renaming={renaming}
              onRowClick={onRowClick}
              onRowOpen={openRow}
              onRowContext={openMenu}
              onStartRename={(row) => startRename(rowKey(row))}
              onCommitRename={commitRename}
              onCancelRename={() => setRenaming(null)}
            />
          ) : (
            <Gallery
              rows={rows}
              selected={selected}
              onRowClick={onRowClick}
              onRowOpen={openRow}
              onRowContext={openMenu}
            />
          )}
          <p className="cs-hint">drop anywhere to upload · right-click for more</p>
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

const FileList = ({
  rows,
  selected,
  renaming,
  onRowClick,
  onRowOpen,
  onRowContext,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: {
  rows: Row[];
  selected: Set<string>;
  renaming: string | null;
  onRowClick: (e: React.MouseEvent, row: Row, index: number) => void;
  onRowOpen: (row: Row) => void;
  onRowContext: (e: React.MouseEvent, row: Row) => void;
  onStartRename: (row: Row) => void;
  onCommitRename: (row: Row, value: string) => void;
  onCancelRename: () => void;
}): React.JSX.Element => (
  <div className="cs-filelist">
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
              <span className="cs-fl-label" onDoubleClick={(e) => (e.stopPropagation(), onStartRename(row))}>
                {row.name}
              </span>
            )}
          </span>
          <span className="cs-fl-size">{row.type === "folder" ? (row.empty ? "—" : formatBytes(row.size)) : formatBytes(row.file.size)}</span>
          <span className="cs-fl-date">{row.type === "file" ? formatDate(row.file.date) : `${row.count} items`}</span>
          <span className="cs-fl-actions">
            {/* frozen → no icon (resting default); active/local states show a small colored icon */}
            <StatusIcon status={status} />
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
        </div>
      );
    })}
  </div>
);

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
  return (
    <input
      className="cs-fl-rename"
      autoFocus
      value={value}
      onClick={(e) => e.stopPropagation()}
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
}: {
  rows: Row[];
  selected: Set<string>;
  onRowClick: (e: React.MouseEvent, row: Row, index: number) => void;
  onRowOpen: (row: Row) => void;
  onRowContext: (e: React.MouseEvent, row: Row) => void;
}): React.JSX.Element => (
  <div className="cs-gallery">
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
            <StatusIcon status={rowStatus(row)} />
          </span>
        </button>
      );
    })}
  </div>
);

// ── first run / empty folder ───────────────────────────────────────

const FirstRun = (): React.JSX.Element => (
  <div className="cs-firstrun">
    <Icon name="cloud_upload" />
    <p className="cs-firstrun-title">Drop files or folders here to upload them</p>
    <p className="cs-firstrun-sub">Drag anything in, or use Add. They're encrypted on your Mac before upload.</p>
  </div>
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
  // Destinations = root + every folder, minus the moved folders themselves (can't move into yourself).
  const moved = new Set(targets.filter((t) => t.kind === "folder").map((t) => t.path));
  const dests = ["", ...allFolderPaths(files, virtualFolders)].filter(
    (p) => !moved.has(p) && ![...moved].some((m) => p === m || p.startsWith(`${m}/`)),
  );
  return (
    <Modal title={`Move ${targets.length === 1 ? "1 item" : `${targets.length} items`} to…`} icon="drive_file_move" onClose={onClose}>
      <div className="cs-stack">
        {dests.map((d) => (
          <button key={d || "root"} type="button" className="cs-menu-item" onClick={() => onMove(d)}>
            <Icon name={d ? "folder" : "home" } size={20} />
            {d ? d : "My Files (root)"}
          </button>
        ))}
      </div>
    </Modal>
  );
};
