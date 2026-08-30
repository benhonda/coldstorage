/**
 * My Files — the front door and the whole drive. A reorganizable filesystem you browse like an external
 * drive: drill-in folders, per-file status badges, drop-to-upload as the hero gesture, Finder-style
 * reorganize, and request-back.
 *
 * Holds no upload logic. The tree comes from {@link useFiles} (the daemon's journal-backed `listFiles`);
 * request-back issues the real `requestRestore` command via `exec`, which records a durable download the
 * daemon then drives — this view starts a download, the Downloads page tracks it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ColdstoreApi, ConflictPolicy, DepositPreview, DepositPreviewItem, ExcludeSuggestion, RetrievalQuote } from "../../../shared/ipc.ts";
import { RECLAIM } from "../../../shared/reclaim-constants.ts";
import type { Exec } from "./types.ts";
import type { FilesApi } from "./files/useFiles.ts";
import type { RunProgress } from "../state/reducer.ts";
import { DepositProgress } from "./DepositProgress.tsx";
import {
  type ArchivedFile,
  type Row,
  type RowTarget,
  baseName,
  canMoveInto,
  childrenOf,
  DEFAULT_SORT,
  type SortKey,
  type SortSpec,
  toggleSort,
  filesUnder,
  formatBytes,
  formatDate,
  isEmptyFolder,
  isUnder,
  isUploadingRow,
  joinPath,
  names,
  parentOf,
  planDeposit,
  reparent,
  restoreBase,
  rewritePrefix,
  restoreOutPath,
  rowKey,
  rowBadges,
  targetOf,
  totalBytes,
  withName,
} from "./files/model.ts";
import { useToast } from "../ui/toast.tsx";
import { Breadcrumb } from "./files/Breadcrumb.tsx";
import {
  back as historyBack,
  canGoBack,
  canGoForward,
  currentDir,
  forward as historyForward,
  initialHistory,
  push as historyPush,
  remapHistory,
} from "./files/history.ts";
import { type MoveDrag, isFileDrag, isMoveDrag, useMoveDrag } from "./files/useMoveDrag.ts";
import { CollisionModal } from "./files/CollisionModal.tsx";
import { SuggestedSkipsModal, type SkipDecision } from "./files/SuggestedSkipsModal.tsx";
import { type DropMatch, matchesInDrop, worthPrompting } from "../state/excludeSuggestions.ts";
import { ContextMenu, type MenuEntry } from "./files/ContextMenu.tsx";
import { FolderTree } from "./files/FolderTree.tsx";
import { InfoModal, type SelectionSummary } from "./files/InfoModal.tsx";
import { RequestBackModal } from "./files/RequestBackModal.tsx";
import { KindIcon, StatusBadges } from "./files/StatusBadge.tsx";
import { failureReason } from "./uploads/failure.ts";
import { Button, EmptyState, IconButton, Icon, Modal } from "../ui/primitives.tsx";
import { Page } from "../ui/layout.tsx";

/** Whether `files` is a fact yet (derived in App from connection + daemon session + the read's own
 * state). Only `ready` may render the empty-vault hero; the others render what they are. */
export type TreeState = { state: "connecting" } | { state: "failed"; reason: string } | { state: "ready" };

interface Props {
  api: ColdstoreApi;
  exec: Exec;
  files: ArchivedFile[];
  tree: TreeState;
  /** Re-read the tree after a failed load. */
  onRetryTree: () => void;
  virtualFolders: string[];
  filesApi: FilesApi;
  /** The daemon's opt-in exclude packs — what the drop-time prompt is able to offer. Empty until the
   *  catalogue loads (or if the daemon is older than the feature), which simply means no prompt. */
  suggestions: ExcludeSuggestion[];
  /** The whole run, for the aggregate deposit banner at the top of the browser (files done, bytes,
   * throughput, ETA). `null` when no run has happened yet. */
  run: RunProgress | null;
  /** Would depositing `incomingBytes` more still fit under the quota? (Phase 5c, size-aware.) The gate
   * weighs what's already stored PLUS what's mid-upload PLUS this deposit's own size, so one oversized
   * drop can't slip past a stored total that hasn't caught up yet. A blocked deposit calls
   * {@link onDepositBlocked} (→ the paywall) instead of uploading. Fails open on unknown usage/quota. */
  hasRoomFor: (incomingBytes: number) => boolean;
  /** Called with the size of the deposit that was refused (0 when the vault was already full before we
   *  knew the size) — the modal it opens says something different for "full" than for "this one is too big". */
  onDepositBlocked: (incomingBytes: number) => void;
  /** Re-upload failed rows from their recorded sources (App owns the daemon call — the sidebar's
   * "couldn't upload" panel offers the very same action, so it lives in one place). */
  onRetryUploads: (scope: ArchivedFile[]) => void;
  /** A failed row we don't know where to find on disk: ask the user, then retry from there. */
  onLocateUpload: (file: ArchivedFile) => void;
  /** Files the Downloads page asked us to re-open the request dialog for (a download that needs buying
   * again — the whole list at once for a grouped row). Null most of the time. */
  requestFileIds?: string[] | null;
  /** Tell the owner we've consumed {@link requestFileIds}, so the same files can be asked for again later. */
  onRequestOpened?: () => void;
  /** Send the user to the Downloads page — the action on the "download started" confirmation, since that
   * page is where the answer to "how's it going" lives. Routing is App's, so this is a callback. */
  onShowDownloads: () => void;
}

type ViewMode = "list" | "grid";
const SORT_LABEL: Record<SortKey, string> = { name: "Name", size: "Size", date: "Date" };
interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

export const MyFilesView = ({
  api,
  exec,
  files,
  tree,
  onRetryTree,
  virtualFolders,
  filesApi,
  suggestions,
  run,
  hasRoomFor,
  onDepositBlocked,
  onRetryUploads,
  onLocateUpload,
  requestFileIds,
  onRequestOpened,
  onShowDownloads,
}: Props): React.JSX.Element => {
  const toast = useToast();
  // Where we are, as a browser-style history so Back / Forward work (see files/history.ts).
  const [history, setHistory] = useState(initialHistory);
  const dir = currentDir(history);
  const [view, setView] = useState<ViewMode>("list");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [requestFiles, setRequestFiles] = useState<ArchivedFile[] | null>(null);
  /** The vault prefix to strip when this request saves to disk (`restoreBase` of what was asked for) —
   * held for the length of the dialog, because the destination folder isn't chosen until it closes. */
  const [requestBase, setRequestBase] = useState("");
  /** The backend's price for the pending request (null while it's still being fetched). The renderer never
   *  computes a restore price — see RequestBackModal's note on why the old local estimate was ~40× wrong. */
  const [quote, setQuote] = useState<RetrievalQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  /** A restore payment in flight — keeps the request dialog up (with a way out) instead of letting a
   *  browser round-trip happen behind a closed dialog. Holds the job it belongs to so "Never mind" can
   *  hand that exact quote back. */
  const [paying, setPaying] = useState<{ jobId: string; phase: "starting" | "browser" | "card" } | null>(null);
  /** Which payment the in-flight async body belongs to. Bumped on every confirm and every cancel, so a
   *  request the user walked away from can't land later and resurrect its own waiting state. */
  const payAttempt = useRef(0);
  const [confirmDelete, setConfirmDelete] = useState<RowTarget[] | null>(null);
  // Is anything being deleted still sitting in a watched folder? Asked before the dialog opens so it can
  // state the consequence up front instead of after the fact. `null` = still asking.
  const [deleteIsWatched, setDeleteIsWatched] = useState<boolean | null>(null);
  const [alsoIgnore, setAlsoIgnore] = useState(true);
  // Which delete the in-flight `pathIsWatched` belongs to. Without it, cancelling a delete for a WATCHED
  // file and immediately opening one for an unwatched file lets the first answer land second — the second
  // dialog then shows a pre-checked "also stop backing this up" for a file that isn't in a watched folder.
  const watchProbe = useRef(0);
  const [moveTargets, setMoveTargets] = useState<RowTarget[] | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  // What a just-accepted drop is being read for, while the daemon walks it. The gap between releasing a
  // folder and the first optimistic row is a full recursive stat of everything in it — on a big drop that
  // is many seconds of an app that looked like it had ignored you (PILLAR5: no invisible work).
  const [preparing, setPreparing] = useState<string | null>(null);
  // Finder-style deposit collision prompt. Promise-bridged: `promptCollisions` opens the modal and resolves
  // when the user picks (a policy map) or cancels (null), so the deposit flow can `await` the decision.
  const [collision, setCollision] = useState<{
    folderName: string;
    collisions: string[];
    resolve: (policies: Record<string, ConflictPolicy> | null) => void;
  } | null>(null);
  // Suggested-skips prompt, promise-bridged the same way — it resolves before the collision prompt opens,
  // because what the user skips here decides which names can collide at all.
  const [skips, setSkips] = useState<{
    folderName: string;
    matches: DropMatch[];
    resolve: (decision: SkipDecision | null) => void;
  } | null>(null);

  const dragDepth = useRef(0);
  /** The OS drag is over, however it ended — take the drop frame down. */
  const settleFileDrag = (): void => {
    dragDepth.current = 0;
    setDropActive(false);
  };
  const lastIndex = useRef<number | null>(null);

  // Sort order — a per-screen preference (localStorage, like the sidebar width), never an account setting.
  const [sort, setSort] = useState<SortSpec>(readSort);
  const sortBy = (key: SortKey): void => {
    const next = toggleSort(sort, key);
    setSort(next);
    try { localStorage.setItem(SORT_KEY, JSON.stringify(next)); } catch { /* private mode / blocked storage — the session still sorts */ }
  };
  const rows = useMemo(() => childrenOf(files, dir, virtualFolders, sort), [files, dir, virtualFolders, sort]);

  // ── navigation resets transient state ──
  const resetTransient = (): void => {
    setSelected(new Set());
    setRenaming(null);
    lastIndex.current = null;
  };
  const goTo = (next: string): void => {
    setHistory((h) => historyPush(h, next));
    resetTransient();
  };
  const goBack = (): void => {
    setHistory(historyBack);
    resetTransient();
  };
  const goForward = (): void => {
    setHistory(historyForward);
    resetTransient();
  };
  /** A folder just moved/renamed (`to`) or was deleted (`to: null`): keep history pointing at real paths. */
  const remapFolder = (from: string, to: string | null): void =>
    setHistory((h) => remapHistory(h, (d) => (isUnder(d, from) ? (to === null ? null : rewritePrefix(d, from, to)) : d)));

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
  //
  // `force` is for the Downloads page's "Ask again": that file's row reads `pending` (it HAS a download —
  // one that needs buying again), so the normal `frozen`-only filter would silently drop it and the button
  // would do nothing. The caller there already knows the download is stalled, so it says so.
  //
  // Takes TARGETS rather than the expanded files, because the two answer different questions and only the
  // targets answer the one that matters at save time: a request for the folder `Photos` and a request for
  // every file inside it expand to the same list, but the first should land as a `Photos` folder on the Mac
  // and the second as loose files. `restoreBase` reads that off the targets; the expanded list can't.
  const openRequest = (targets: RowTarget[], force = false): void => {
    const candidates = filesForTargets(targets);
    const restorable = force ? candidates : candidates.filter((f) => f.status === "frozen");
    if (restorable.length === 0) return;
    setRequestFiles(restorable);
    setRequestBase(restoreBase(targets));
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

  /** Hand the restore to the daemon, once it's authorized. The daemon writes a durable row and its run
   *  loop takes it from here — so the download survives a sign-out, a quit, and the ~48h thaw, which is
   *  exactly what the dialog promises when it says you can close the app. */
  const startRestore = (files: ArchivedFile[], base: string, folder: string, jobId: string): void => {
    for (const f of files) {
      // Keeps the folder structure the vault already has (see `restoreBase`). The daemon creates the
      // intermediate directories on its way to writing the file.
      const out = restoreOutPath(f.relativePath, base, folder);
      exec(() => api.request("requestRestore", { file: f.id, out, jobId }));
    }
    // Say it worked. Until now the app answered a click on "Start download" with nothing at all — the
    // dialog closed and you had to go find the Downloads page yourself to learn whether anything had
    // happened. The countdown lives on that page, so the toast points at it rather than restating it.
    toast.success(
      files.length === 1
        ? `Started. ${baseName(files[0]?.relativePath ?? "")} is on its way.`
        : `Started. ${files.length} files are on their way.`,
      { label: "See downloads", onClick: onShowDownloads },
    );
  };

  /**
   * A free restore starts at once. A PAID one keeps the dialog open through the payment — the charge may
   * bounce the user out to Paddle in their browser, and that wait needs to be visible, reopenable and
   * abandonable rather than happening behind a dialog that already closed (PILLAR5).
   */
  const confirmRequest = (folder: string): void => {
    const files = requestFiles ?? [];
    const job = quote;
    // Read before the dialog closes — the async body below outlives this render, and the base belongs to
    // the request that was just confirmed, not to whatever gets asked for next.
    const base = requestBase;
    if (!job) return; // never start a download we couldn't price — the button is disabled, but be certain

    if (job.quoteCents === 0) {
      setRequestFiles(null);
      startRestore(files, base, folder, job.jobId);
      return;
    }

    // Set BEFORE the await: the charge request takes a round trip, and until this lands the dialog would
    // still be showing a live "Pay and start" — a second click would create a second transaction.
    setPaying({ jobId: job.jobId, phase: "starting" });
    const attempt = ++payAttempt.current;
    void (async () => {
      const current = (): boolean => payAttempt.current === attempt;
      try {
        // Pay first: `awaitRestorePayment` resolves only once the webhook confirms the money AND the
        // backend has begun thawing — so by the time we issue `restore`, the daemon will find the blobs
        // thawing rather than frozen.
        const { checkoutOpened } = await api.startRestorePayment(job.jobId);
        if (!current()) return; // cancelled while the charge was starting
        setPaying({ jobId: job.jobId, phase: checkoutOpened ? "browser" : "card" });
        const paid = await api.awaitRestorePayment(job.jobId);
        if (!current()) return; // walked away — `cancelPayment` already closed up and refunded the quote
        setPaying(null);
        if (!paid) return;
        setRequestFiles(null);
        startRestore(files, base, folder, job.jobId);
      } catch (e) {
        // A failed payment is the last thing that should fail silently — the user just agreed to be
        // charged and needs to know they weren't. The dialog closes with it, so this goes to a toast.
        if (!current()) return; // they already walked away; don't report a payment they abandoned
        setPaying(null);
        setRequestFiles(null);
        toast.error(`Couldn't take the payment (${e instanceof Error ? e.message : String(e)}). Nothing was charged, and the download didn't start.`);
      }
    })();
  };

  /** "Never mind" mid-payment: stop waiting, hand the quote back so it costs none of the free monthly
   *  allowance, and put the user back where they were. */
  const cancelPayment = (): void => {
    const jobId = paying?.jobId;
    payAttempt.current += 1; // orphan the in-flight body (see `payAttempt`)
    setPaying(null);
    setRequestFiles(null);
    if (jobId) void api.cancelRestorePayment(jobId);
  };

  // The Downloads page asked to re-open the request dialog for files whose download needs re-buying.
  // Consumed once (`onRequestOpened`) so asking for the same files again later still works.
  useEffect(() => {
    if (!requestFileIds || requestFileIds.length === 0) return;
    const wanted = new Set(requestFileIds);
    const targets: RowTarget[] = files
      .filter((x) => wanted.has(x.id))
      .map((f) => ({ kind: "file", id: f.id, path: f.relativePath }));
    if (targets.length > 0) openRequest(targets, true);
    onRequestOpened?.();
    // `files` is deliberately not a dep: this must fire on the REQUEST, not on every tree refresh, or a
    // background `listFiles` would re-open a dialog the user just dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestFileIds]);

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
      if (target.kind === "folder") remapFolder(target.path, to);
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
  // Delete = tombstone each target's subtree in the journal. Bytes are reclaimed once every file sharing
  // their blob is deleted; the space returns when Deep Archive's 180-day minimum on them runs out.
  // Optimistic drop from the tree, then the REAL daemon `deletePath` per target.
  const doDelete = (targets: RowTarget[]): void => {
    filesApi.remove(targets);
    targets.forEach((t) => t.kind === "folder" && remapFolder(t.path, null));
    // Send `alsoIgnore` ONLY when the checkbox was actually on screen. It defaults to true, and the daemon
    // evaluates watched-ness itself — so sending it unconditionally would add an exclude in the two windows
    // where the user never saw the choice: while the probe is still in flight, and when the probe failed.
    // An exclude is a lasting decision about what gets backed up; it needs to have been offered.
    const ignoreParam = deleteIsWatched === true ? ({ alsoIgnore: alsoIgnore ? "true" : "false" } as const) : {};
    exec(() =>
      Promise.all(targets.map((t) => api.request("deletePath", { path: t.path, ...ignoreParam }))),
    );
    setSelected(new Set());
    closeDeleteConfirm();
  };
  /** One place to drop the confirm state, so cancelling can't leave a stale watched-flag behind. */
  const closeDeleteConfirm = (): void => {
    watchProbe.current++;   // orphan any in-flight probe
    setConfirmDelete(null);
    setDeleteIsWatched(null);
    setAlsoIgnore(true);
  };
  // Confirm only when there are real uploaded bytes at stake; an empty folder just goes.
  const requestDelete = (targets: RowTarget[]): void => {
    if (filesForTargets(targets).length === 0) {
      doDelete(targets);   // an empty folder has nothing at stake and nothing to come back
      return;
    }
    setConfirmDelete(targets);
    setDeleteIsWatched(null);
    setAlsoIgnore(true);   // default to the option that makes the delete actually hold
    // Resolve watched-ness while the dialog is already up, so opening it never blocks on IPC. The
    // generation token discards an answer that arrives after this dialog is gone (see `watchProbe`).
    const gen = ++watchProbe.current;
    void Promise.all(targets.map((t) => api.request("pathIsWatched", { path: t.path })))
      .then((rs) => {
        if (watchProbe.current === gen) setDeleteIsWatched(rs.some((r) => r.isWatched));
      })
      .catch((e: unknown) => {
        // Can't tell → claim nothing, and say so rather than failing silently: the delete still works,
        // it just won't offer the exclude, and a swallowed error here is invisible work going wrong.
        console.warn("pathIsWatched failed — delete will not offer the watched-folder option", e);
        if (watchProbe.current === gen) setDeleteIsWatched(false);
      });
  };
  const clearSelection = (): void => setSelected(new Set());
  // Move each target's subtree under `toDir`. Optimistic re-parent, then the REAL daemon `movePath` per
  // target ({ from: full path, to: toDir/basename }); `filesChanged` reconciles to journal truth.
  // The one move op behind BOTH gestures — the "Move to…" picker and a drag-drop.
  const moveTo = (targets: RowTarget[], toDir: string): void => {
    // A target already living in `toDir` is a put-back — a legal drop (Finder accepts it) but not a
    // move, so it never reaches the daemon (movePath from == to). All-put-back just settles the drag.
    const moving = targets.filter((t) => parentOf(t.path) !== toDir);
    if (moving.length > 0) {
      filesApi.move(moving, toDir);
      moving.forEach((t) => t.kind === "folder" && remapFolder(t.path, reparent(t.path, toDir)));
      exec(() => Promise.all(moving.map((t) => api.request("movePath", { from: t.path, to: reparent(t.path, toDir) }))));
    }
    setSelected(new Set());
  };
  const doMove = (toDir: string): void => {
    if (moveTargets) moveTo(moveTargets, toDir);
    setMoveTargets(null);
  };

  // ── drag-to-move (the Finder gesture; see useMoveDrag for the native-DnD rationale) ──
  const drag = useMoveDrag({
    targetsFor: (row) => {
      // Dragging a selected row carries the whole selection; dragging an unselected row re-anchors the
      // selection to just it (Finder semantics — the drag acts on what looks picked up).
      if (selected.has(rowKey(row))) return selectedRows.map(targetOf);
      setSelected(new Set([rowKey(row)]));
      return [targetOf(row)];
    },
    onMove: moveTo,
    onOpen: goTo, // spring-load: holding over a folder/crumb drills in mid-drag
    // An OS drop released ON a folder row/tile/crumb uploads into THAT folder — no need to open it first.
    onDropFiles: (files, dest) => depositFiles(files, dest), // declared below; only ever called on a drop
    onDragEnded: settleFileDrag, // the frame comes down on ANY end — drop, Esc, off-window — not just a drop here
  });

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
    // Failed uploads in the selection (a folder counts every failed file under it) → their actions at the
    // top: Try again for the ones with a recorded source, Locate… for a single one without.
    const failed = filesForTargets(targets).filter((f) => f.status === "failed");
    const retryable = failed.filter((f) => f.sourcePath !== null);
    const locatable = single?.type === "file" && single.file.status === "failed" && single.file.sourcePath === null ? single.file : null;
    const uploadActions: MenuEntry[] = [
      ...(retryable.length > 0
        ? [{ label: retryable.length > 1 ? `Try again (${retryable.length})` : "Try again", icon: "refresh", onClick: () => onRetryUploads(retryable) }]
        : []),
      ...(locatable ? [{ label: "Locate…", icon: "search", onClick: () => onLocateUpload(locatable) }] : []),
    ];
    const items: MenuEntry[] = targets.length
      ? [
          ...(uploadActions.length > 0 ? ([...uploadActions, "separator"] as MenuEntry[]) : []),
          { label: "Get info", icon: "info", onClick: () => setInfoOpen(true), disabled: !single },
          { label: "Rename", icon: "edit", onClick: () => single && startRename(rowKey(single)), disabled: !single },
          { label: "Move to…", icon: "drive_file_move", onClick: () => setMoveTargets(targets) },
          { label: "New folder", icon: "create_new_folder", onClick: doNewFolder },
          "separator",
          { label: "Request a download…", icon: "download", onClick: () => openRequest(targets), disabled: restorable.length === 0 },
          { label: "Delete", icon: "delete", danger: true, onClick: () => requestDelete(targets) },
        ]
      : [
          { label: "Upload files or folders…", icon: "upload", onClick: addUploads },
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

  // The suggested-skips prompt, same shape: resolves with the user's decision, or null if they cancelled
  // the drop outright.
  const promptSkips = (folderName: string, matches: DropMatch[]): Promise<SkipDecision | null> =>
    new Promise((resolve) => setSkips({ folderName, matches, resolve }));

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
    srcByPath: Map<string, string>; // previewed vault path → local source path (top-level picks only) so a failed upload can retry
    fallback: string[]; // target relativePaths — names the drop in the UI, and stands in for an unavailable photo preview
  }): Promise<void> => {
    // Quota gate, pass 1 (Phase 5c): if the vault is already full, bail to the paywall before any
    // preview/optimistic rows so a blocked drop leaves the tree untouched. The size-aware pass 2 (below,
    // once we know which files land and how big they are) is what stops a single drop that would overflow.
    if (!hasRoomFor(0)) {
      onDepositBlocked(0);
      return;
    }
    let preview: DepositPreviewItem[];
    let notUploaded: DepositPreview["skipped"] = [];
    // The drop is now visibly working. Until this landed, everything between the drop and the first
    // optimistic row — a full recursive walk of the dropped folder — drew nothing at all.
    const label = opts.kind === "photos" ? "photos" : names(opts.fallback);
    setPreparing(label);
    try {
      const previewed = await api.request(
        "previewDeposit",
        opts.kind === "files" ? { dest: opts.dest, src: opts.wire } : { dest: opts.dest, assetIds: opts.wire },
      );
      preview = previewed.items;
      notUploaded = previewed.skipped;
    } catch (e) {
      // Photos: the picker already told us the names, so a resolver hiccup shouldn't cancel the deposit.
      // Files: there is no such second source of truth. Fabricating one used to hide the failure AND feed
      // the quota gate a zero — so the drop that most needed the gate was the one that skipped it. Surface it.
      if (opts.kind === "files") throw e;
      // `suggestedPack: null` isn't a guess — a photo pick has no filesystem junk in it to suggest,
      // which is the same reason the prompt below is files-only.
      preview = opts.fallback.map((relativePath) => ({ relativePath, size: 0, exists: false, suggestedPack: null }));
    } finally {
      setPreparing(null);
    }
    // What the drop contained that ColdStorage doesn't back up — today, symlinks. Said out loud, once, up
    // front: the alternative is an item that was dropped and simply never appears (PILLAR5).
    if (notUploaded.length > 0) {
      const n = notUploaded.length;
      toast.error(
        n === 1
          ? `${baseName(notUploaded[0]?.relativePath ?? "")} is a symlink, so it won't be uploaded — ColdStorage backs up files, not links to them.`
          : `${n} items in this drop are symlinks and won't be uploaded — ColdStorage backs up files, not links to them.`,
      );
    }
    // ── suggested skips ──
    // The daemon tagged every previewed file that one of its opt-in packs would have caught. If that adds
    // up to something worth stopping a person for, ask BEFORE anything uploads — the only moment the
    // answer is still free (Deep Archive bills a 180-day minimum the instant bytes land).
    //
    // This runs BEFORE the collision prompt on purpose: skipping changes which files land, so asking about
    // collisions first would prompt the user about names that are then dropped anyway.
    let excludeExtra: string[] = [];
    /** Did the user's own skip choice empty this drop? Distinguishes "you chose to skip all of it" from
     *  "we couldn't read any of it" below — the same two-different-reasons split the empty-plan branch
     *  already makes, and the reason a deliberate choice must never surface as a red failure. */
    let emptiedBySkips = false;
    if (opts.kind === "files" && suggestions.length > 0) {
      const matches = matchesInDrop(preview, suggestions);
      if (worthPrompting(matches)) {
        const decision = await promptSkips(opts.dest, matches);
        if (!decision) return; // cancelled → abort the whole drop, no upload
        const chosen = new Set(decision.packIds);
        excludeExtra = matches.filter((m) => chosen.has(m.pack.id)).flatMap((m) => m.pack.patterns);
        // Drop the skipped files from the preview so every downstream step — collisions, optimistic rows,
        // the quota gate — is computed over what will ACTUALLY land. The daemon enforces it for real via
        // `excludeExtra`; this keeps the UI's arithmetic honest rather than merely agreeing by luck.
        const kept = preview.filter((p) => p.suggestedPack === null || !chosen.has(p.suggestedPack));
        emptiedBySkips = kept.length === 0 && preview.length > 0;
        preview = kept;
        // "Remember this" is the separate, persistent half — the same one-button-fix shape as deleting a
        // file with `alsoIgnore`. Its failure is reported on its own and does NOT abort the drop: the user
        // asked to upload files, and saving a preference is the side errand. Letting this reject would
        // have cancelled the whole deposit over a setting that didn't stick — the wrong consequence, and
        // one the user never asked for. The skip itself still holds for this run, via `excludeExtra`.
        if (decision.remember && excludeExtra.length > 0) {
          try {
            for (const pattern of excludeExtra) await api.request("addExclude", { pattern });
          } catch (e) {
            toast.error(
              `Skipped them this time, but couldn't save that for next time: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    }

    const collisions = preview.filter((p) => p.exists).map((p) => p.relativePath);
    let policies: Record<string, ConflictPolicy> = {};
    if (collisions.length > 0) {
      const chosen = await promptCollisions(opts.dest, collisions);
      if (!chosen) return; // cancelled → abort the whole drop, no upload
      policies = chosen;
    }
    const { rows, conflicts } = planDeposit(preview, policies, new Set(files.map((f) => f.relativePath)));
    // Nothing will land. Two very different reasons, and neither may pass as a successful no-op (PILLAR5):
    // an empty preview means the daemon found nothing it could read or nothing the excludes let through —
    // the exact shape of "I dropped a folder and absolutely nothing happened". An empty plan with a
    // non-empty preview means the user chose Skip on every collision, which is a decision, not a failure.
    if (rows.length === 0) {
      // Dropping a folder that turns out to be nothing BUT skippable junk is a complete, successful answer
      // to the question we just asked. Reporting it as "nothing in there is readable" would call the
      // user's own decision a fault.
      if (emptiedBySkips) return;
      if (preview.length === 0) {
        throw new Error(
          `Nothing to upload from ${label} — nothing in there is readable, or all of it is excluded.`,
        );
      }
      return;
    }
    // Byte size per landing row, sourced from the daemon's preview (`original` is the previewed path each
    // row keys off). This is the SSOT for "how big is this deposit" — files, whole folders, and photos
    // alike — so the quota gate below is exact regardless of how the items were chosen. 0 only for a photo
    // whose size isn't resolvable yet; the daemon's usage read reconciles those on the next refresh.
    const sizeByOriginal = new Map(preview.map((p) => [p.relativePath, p.size]));
    // Quota gate, pass 2: now we know which files actually land (post-collision-resolution) and how big
    // they are, so refuse the drop if it would overflow the quota.
    const incomingBytes = rows.reduce((sum, r) => sum + (sizeByOriginal.get(r.original) ?? 0), 0);
    if (!hasRoomFor(incomingBytes)) {
      onDepositBlocked(incomingBytes);
      return;
    }
    // Optimistic "uploading" rows for what will land — names carry their full vault path (so intoDir is "").
    // Each carries its source path (for retry) and byte size (for the in-flight half of the quota gate).
    const optimisticIds = filesApi.deposit(
      rows.map((r) => {
        const sourcePath = opts.srcByPath.get(r.original);
        const size = sizeByOriginal.get(r.original);
        return { name: r.relativePath, ...(sourcePath ? { sourcePath } : {}), ...(size != null ? { size } : {}) };
      }),
      "",
    );
    // Only attach `conflicts` when there's something to resolve (exactOptionalPropertyTypes — omit, don't undefined).
    const extra = Object.keys(conflicts).length > 0 ? { conflicts: JSON.stringify(conflicts) } : {};
    // The user's "skip those" applied to THIS run — the daemon honors these patterns for this deposit and
    // then forgets them, whether or not they also chose to remember them.
    const skipped = excludeExtra.length > 0 ? { excludeExtra: excludeExtra.join("\n") } : {};
    const sent =
      opts.kind === "files"
        ? api.request("deposit", { src: opts.wire, dest: opts.dest, ...extra, ...skipped })
        : api.request("depositPhotos", { assetIds: opts.wire, dest: opts.dest, ...extra });
    await sent.catch((e: unknown) => {
      // Command rejected → ⚠ on the rows, don't strand them — and carry the daemon's reason onto the row,
      // so the failure the user just caused is at least as explicable as a background one.
      filesApi.setDepositStatus(optimisticIds, "failed", `${e}`);
      throw e;
    });
  };

  // ── deposit (hero) — REAL upload of chosen paths ──
  // The one deposit path for BOTH the native "Add" picker and a drag-drop: absolute file/folder paths in,
  // the daemon walks any directory among them (structure preserved) and the preview prices every item for
  // the quota gate (so no per-file size is needed here). `srcByPath` maps each TOP-LEVEL pick's landing path
  // → its source, so a failed loose-file upload can retry; a folder's inner files aren't individually
  // retryable (re-add the folder). Keyed by the vault path (`dir`/basename) the row will report as
  // `original`, matching how the size map is keyed — one lookup key for both.
  // `dest` is the vault folder they land in — the open one for the picker and a blank-area drop, or the
  // folder a drop was released ON (row / tile / crumb).
  const depositPaths = (paths: string[], dest: string): void => {
    if (paths.length === 0) return;
    const srcByPath = new Map(paths.map((p) => [joinPath(dest, baseName(p)), p]));
    exec(() =>
      runDeposit({
        kind: "files",
        wire: paths.join("\n"),
        dest,
        srcByPath,
        fallback: paths.map((p) => joinPath(dest, baseName(p))), // coarse rows if the preview can't run
      }),
    );
  };
  // Drag-drop → resolve each dropped File to its absolute path (in the preload; Electron 32+ dropped
  // `File.path`), then deposit exactly like a picker selection. A dropped folder yields its directory path,
  // which the daemon walks.
  const depositFiles = (dropped: File[], dest: string): void => {
    if (dropped.length === 0) return;
    const paths = dropped.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length === 0) {
      // Couldn't resolve any local paths → show ⚠ rows rather than vanishing.
      const ids = filesApi.deposit(dropped.map((f) => ({ name: f.name })), dest);
      filesApi.setDepositStatus(ids, "failed", "couldn't find these on disk to upload them");
      return;
    }
    depositPaths(paths, dest);
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
        srcByPath: new Map(), // photos have no local source path (the daemon resolves them from the library)
        fallback: picks.map((p) => joinPath(dir, p.name)),
      });
    });
  };
  // ── add (native files-AND-folders picker) — the primary deposit gesture ──
  // One native panel selects any mix of files and folders, multi-select (the web <input> can't offer
  // folders at all). Whatever's picked flows through the same deposit path as a drag-drop; the daemon walks
  // any chosen directory and preserves its structure. Cancel / pick-nothing is a no-op (resolves []).
  const addUploads = (): void => {
    exec(async () => depositPaths(await api.chooseUploads(), dir));
  };
  // A drop on the blank area / a file row / anywhere not a folder = "into the OPEN folder". A drop ON a
  // folder row/tile/crumb never reaches here — the folder target consumes it (useMoveDrag.onDropFiles).
  // The frame comes down via `onDragEnded` (the hook's document-level drop hook fires `reset`).
  // An Esc'd (refused) drag is left to the browser default: no preventDefault → Finder snaps it back.
  const onDrop = (e: React.DragEvent): void => {
    if (isMoveDrag(e) || drag.isRefused()) return; // a row drag is never an upload (folder targets consume it)
    e.preventDefault();
    depositFiles([...e.dataTransfer.files], dir);
  };
  const onDragEnter = (e: React.DragEvent): void => {
    if (!isFileDrag(e)) return;
    drag.track();
    if (drag.isRefused()) return; // keep tracking so the real end still resets, but no frame
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
      if ((e.metaKey || e.ctrlKey) && (e.key === "[" || e.key === "]")) {
        // Finder's ⌘[ / ⌘] — Back / Forward.
        e.preventDefault();
        if (e.key === "[") goBack();
        else goForward();
      } else if (e.key === "Escape") {
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
      <IconButton
        icon="swap_vert"
        label="Sort"
        title={`Sorted by ${SORT_LABEL[sort.key]}, ${sort.dir === "asc" ? "ascending" : "descending"}`}
        onClick={(e) =>
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: (["name", "size", "date"] as const).map((key) => ({
              label: SORT_LABEL[key],
              // the active column shows which way it points; clicking it flips it, like the header does
              ...(sort.key === key ? { icon: sort.dir === "asc" ? "arrow_upward" : "arrow_downward" } : {}),
              onClick: () => sortBy(key),
            })),
          })
        }
      />
      <IconButton icon="create_new_folder" label="New folder" onClick={doNewFolder} />
      <Button variant="primary" icon="add" onClick={addUploads}>
        Add
      </Button>
    </>
  );

  return (
    <Page title="My Files" actions={actions} fill>
      <div
        className="cs-browser"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={(e) => {
          // An internal row drag is only accepted by folder rows/tiles and crumbs (their own handlers);
          // leaving default here shows the no-drop cursor over everything else — Finder-style.
          if (isMoveDrag(e)) return;
          drag.track();
          if (drag.isRefused()) return; // Esc'd: no-drop cursor, and a release lands nothing
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={onDrop}
      >
        {/* The blank area stands in for the CURRENT directory as a drop target (file rows bubble here
            too — dropping on a file means "into this folder", like Finder). This is what makes a
            spring-opened folder land the drop: spring in, release anywhere. A drop into the dir the
            items already live in is refused (no-op), so nothing lights up before any spring. */}
        <div
          className={dropActive || drag.isDropTarget(dir) ? "cs-browser-main cs-browser-main--drop" : "cs-browser-main"}
          {...drag.background(dir)}
          onClick={(e) => e.target === e.currentTarget && clearSelection()}
          onContextMenu={(e) => e.target === e.currentTarget && openMenu(e)}
        >
          <DepositProgress
            run={run}
            preparing={preparing}
            onStop={() => exec(() => api.request("cancelRun"))}
          />
          {/* FirstRun (the drop-zone hero) is the onboarding state for a genuinely empty vault — root with
              nothing in it. A drilled-into empty folder just shows the empty file list, not the hero. And
              "nothing in it" has to be a FACT: while the tree is still loading, or its read failed, the
              same empty `rows` mean nothing at all, and the hero would be a lie (see `TreeState`). */}
          {rows.length === 0 && dir === "" && tree.state !== "ready" ? (
            <TreeStatus tree={tree} onRetry={onRetryTree} />
          ) : rows.length === 0 && dir === "" ? (
            <FirstRun onChoose={addUploads} onContextMenu={openMenu} />
          ) : (
            <>
              {/* ONE card surface: the where-am-I row (Back / Forward + breadcrumb) sits on the white of the
                  table itself, above the column headers — not on the page chrome, so the page title stays
                  "My Files" wherever you've drilled to. The list/gallery scrolls inside it. */}
              <div className="cs-files-card">
                <div className="cs-browser-nav">
                  <IconButton
                    icon="arrow_back"
                    label="Back"
                    title="Back (⌘[)"
                    className={drag.isHolding("back") ? "cs-iconbtn--ghost cs-iconbtn--hold" : "cs-iconbtn--ghost"}
                    disabled={!canGoBack(history)}
                    onClick={goBack}
                    {...drag.hold("back", goBack)}
                  />
                  <IconButton
                    icon="arrow_forward"
                    label="Forward"
                    title="Forward (⌘])"
                    className={drag.isHolding("forward") ? "cs-iconbtn--ghost cs-iconbtn--hold" : "cs-iconbtn--ghost"}
                    disabled={!canGoForward(history)}
                    onClick={goForward}
                    {...drag.hold("forward", goForward)}
                  />
                  <Breadcrumb dir={dir} onNavigate={goTo} drag={drag} />
                </div>
                {/* The OS-drag frame is the card's own dashed outline (`cs-browser-main--drop`) plus this
                    caption — NOT a sheet over the list: the rows stay visible and hoverable so the drag
                    can be aimed at a folder row / crumb, or held over Back / Forward. */}
                {dropActive && (
                  <div className="cs-drop-caption">
                    <Icon name="cloud_upload" />
                    <span>Drop to upload here, or onto a folder</span>
                  </div>
                )}
                {view === "list" ? (
                  <FileList
                    rows={rows}
                    selected={selected}
                    renaming={renaming}
                    drag={drag}
                    onRowClick={onRowClick}
                    onRowOpen={openRow}
                    onRowContext={openMenu}
                    onStartRename={(row) => startRename(rowKey(row))}
                    onCommitRename={commitRename}
                    onCancelRename={() => setRenaming(null)}
                    onClearSelection={clearSelection}
                    sort={sort}
                    onSort={sortBy}
                  />
                ) : (
                  <Gallery
                    rows={rows}
                    selected={selected}
                    drag={drag}
                    onRowClick={onRowClick}
                    onRowOpen={openRow}
                    onRowContext={openMenu}
                    onClearSelection={clearSelection}
                  />
                )}
              </div>
              <p className="cs-hint">drop anywhere to upload · right-click for more</p>
            </>
          )}
        </div>

      </div>

      {infoOpen && sel && (
        <InfoModal
          sel={sel}
          onDownload={() => {
            setInfoOpen(false);
            // The SELECTION, not `sel.restorable` — Get info on a folder must still request the folder, so
            // the copy lands as a folder. `openRequest` filters to what's actually restorable itself.
            openRequest(selectedRows.map(targetOf));
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
          paying={paying}
          onConfirm={confirmRequest}
          onCancelPayment={cancelPayment}
          onReopenCheckout={() => {
            void api.reopenRestoreCheckout().catch((e: unknown) => {
              toast.error(`Couldn't reopen the checkout page (${e instanceof Error ? e.message : String(e)}).`);
            });
          }}
          onClose={() => {
            // Let go of an unpaid quote so it burns none of the user's free monthly allowance.
            if (quote && quote.quoteCents > 0) void api.abandonQuote(quote.jobId);
            setRequestFiles(null);
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          title="Delete from your files?"
          icon="delete"
          onClose={closeDeleteConfirm}
          footer={
            <>
              <Button variant="ghost" onClick={closeDeleteConfirm}>
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
            files. Space comes back once the bytes pass {RECLAIM.minimumStorageDays} days in deep storage —
            right away for anything you've had a while.
          </p>
          {deleteIsWatched && (
            <label className="cs-optin">
              <input
                type="checkbox"
                checked={alsoIgnore}
                onChange={(e) => setAlsoIgnore(e.currentTarget.checked)}
              />
              <span>
                <strong>Also stop backing this up.</strong>{" "}
                {confirmDelete.length === 1 ? "It's" : "Some of these are"} still in a folder you're
                watching, so without this {confirmDelete.length === 1 ? "it stays" : "they stay"} on your
                Mac but won't be backed up again — and nothing here would say why.
              </span>
            </label>
          )}
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

      {skips && (
        <SuggestedSkipsModal
          folderName={baseName(skips.folderName)}
          matches={skips.matches}
          onConfirm={(decision) => {
            skips.resolve(decision);
            setSkips(null);
          }}
          onClose={() => {
            skips.resolve(null); // cancel → abort the deposit
            setSkips(null);
          }}
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
  drag,
  onRowClick,
  onRowOpen,
  onRowContext,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onClearSelection,
  sort,
  onSort,
}: {
  rows: Row[];
  selected: Set<string>;
  renaming: string | null;
  drag: MoveDrag;
  sort: SortSpec;
  onSort: (key: SortKey) => void;
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

  // Virtualized: only the rows in (and just around) the viewport exist in the DOM. A 5k-file folder used
  // to be 5k live rows, re-rendered on every daemon event — the lag a big drop was felt as. Heights are
  // measured (`measureElement`), so the estimate only has to be close; `--cs-row-h` is the real one.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 12,
    getItemKey: (i) => {
      const row = rows[i];
      return row ? rowKey(row) : i;
    },
  });

  return (
  // Finder-style: a click that lands on the list's blank area (the card itself, the header, or the filler
  // — anything that isn't a row) clears the selection; a right-click there opens the empty-area menu.
  <div
    ref={scrollRef}
    className="cs-filelist"
    onClick={(e) => isBlankArea(e, ".cs-fl-row, .cs-fl-head") && onClearSelection()}
    onContextMenu={(e) => isBlankArea(e, ".cs-fl-row, .cs-fl-head") && onRowContext(e)}
  >
    <div className="cs-fl-grid cs-fl-head" role="row">
      <SortHeader label="Name" col="name" sort={sort} onSort={onSort} />
      <SortHeader label="Size" col="size" sort={sort} onSort={onSort} />
      <SortHeader label="Date" col="date" sort={sort} onSort={onSort} />
      <span />
    </div>
    {/* the scroll runway: as tall as every row would be, with only the visible ones placed inside it */}
    <div className="cs-fl-body" style={{ height: virtualizer.getTotalSize() }}>
    {virtualizer.getVirtualItems().map((item) => {
      const row = rows[item.index];
      if (!row) return null; // unreachable — the virtualizer indexes `rows` — satisfies noUncheckedIndexedAccess
      const i = item.index;
      const key = rowKey(row);
      const isFolder = row.type === "folder";
      const badges = rowBadges(row);
      const src = drag.source(row);
      // zebra by index, not :nth-child — only a window of rows is ever in the DOM, so DOM parity is meaningless
      const classes = [
        "cs-fl-grid",
        "cs-fl-row",
        i % 2 === 1 ? "cs-fl-row--even" : "",
        isFolder && drag.isDropTarget(row.path) ? "cs-fl-row--drop" : "",
      ].filter(Boolean).join(" ");
      return (
        <div
          key={item.key}
          ref={virtualizer.measureElement}
          data-index={i}
          className={classes}
          style={{ transform: `translateY(${item.start}px)` }}
          role="row"
          aria-selected={selected.has(key)}
          draggable={renaming !== key}
          onDragStart={(e) => {
            cancelPress(); // a drag is a drag — never a hold-to-rename
            src.onDragStart(e);
          }}
          onDragEnd={src.onDragEnd}
          {...(isFolder ? drag.target(row.path) : {})}
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
          {/* A folder's date is its newest descendant's — the same value the Date sort uses (model.ts
              `FolderRow.date`) — so what the column shows and what it orders by never disagree. Files
              archived before they carried metadata have no date at all and show "—" either way. The
              folder's item count lives in Get info, not here: it's not a date. */}
          <span className="cs-fl-date">{formatDate(row.type === "file" ? row.file.date : row.date)}</span>
          <span className="cs-fl-actions">
            {/* A quiet spinner rides beside the status icon while this row is in flight — just a "this one's
                going" cue. The quantitative progress (bytes, %, ETA) lives in the deposit banner up top, so
                the row doesn't repeat it; it only marks which file is uploading right now. */}
            {isUploadingRow(badges) && <span className="cs-spinner" aria-hidden="true" />}
            {/* status icon by the ⋯: ✓ stored · ↑ uploading · ⚠ couldn't upload · ↓ transferring · saved-here.
                An empty folder has nothing stored, so it shows no badge. */}
            {/* `reason` is the words for the row's failure kind (`uploads/failure.ts`), so a ⚠ or a stalled
                row can say WHY on hover instead of leaving the user to guess. Folders roll up a status but
                not a reason — a folder has no single fault to name. */}
            {!isEmptyFolder(row) && (
              <StatusBadges badges={badges} reason={row.type === "file" ? failureReason(row.file) : null} />
            )}
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
    {/* striped filler so the zebra reads continuously into the empty space below the last row (and fills
        the body of an empty folder). Shift by one band when the row count is odd so parity continues. */}
    <div
      className="cs-fl-filler"
      aria-hidden="true"
      style={{ "--fill-shift": rows.length % 2 === 0 ? "0px" : "var(--cs-row-h)" } as React.CSSProperties}
    />
  </div>
  );
};

/** A column header that sorts — Finder's: click to sort by it, click again to flip. The caret shows only on
 * the active column. */
const SortHeader = ({ label, col, sort, onSort }: { label: string; col: SortKey; sort: SortSpec; onSort: (key: SortKey) => void }): React.JSX.Element => {
  const active = sort.key === col;
  return (
    <button
      type="button"
      className={active ? "cs-fl-sort cs-fl-sort--active" : "cs-fl-sort"}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(col)}
    >
      {label}
      {active && <Icon name={sort.dir === "asc" ? "arrow_upward" : "arrow_downward"} size={14} />}
    </button>
  );
};

/** localStorage key for the sort order — `cs-` namespaced, like the sidebar width and density. */
const SORT_KEY = "cs-files-sort";
const readSort = (): SortSpec => {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as unknown;
    if (raw && typeof raw === "object" && "key" in raw && "dir" in raw) {
      const { key, dir } = raw as { key: unknown; dir: unknown };
      if ((key === "name" || key === "size" || key === "date") && (dir === "asc" || dir === "desc")) return { key, dir };
    }
  } catch { /* nothing stored, or storage unavailable */ }
  return DEFAULT_SORT;
};

/** Row-height estimate for the virtualizer, before a row is measured: `--cs-row-h` (`--control-md`). */
const ROW_ESTIMATE_PX = 34;
/** Gallery-row estimate: a 4:3 tile at the minimum column width, plus its foot. Measured once rendered. */
const TILE_ROW_ESTIMATE_PX = 170;

/** Did this click land on the container's own blank area — nothing matching `rowSelector` under it? The
 * virtualized lists wrap their rows in a runway element, so `target === currentTarget` no longer means
 * "blank": the runway is a hit too. */
const isBlankArea = (e: React.MouseEvent, rowSelector: string): boolean =>
  !(e.target instanceof Element && e.target.closest(rowSelector));

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

/** How many tiles fit across `el` under the gallery's own CSS (`--cs-tile-min` + `column-gap`), so the
 * CSS stays the one place the tile width is decided. */
const galleryColumns = (el: HTMLElement): number => {
  const cs = getComputedStyle(el);
  const min = parseFloat(cs.getPropertyValue("--cs-tile-min")) || 150;
  const gap = parseFloat(cs.columnGap) || 0;
  const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
};

const Gallery = ({
  rows,
  selected,
  drag,
  onRowClick,
  onRowOpen,
  onRowContext,
  onClearSelection,
}: {
  rows: Row[];
  selected: Set<string>;
  drag: MoveDrag;
  onRowClick: (e: React.MouseEvent, row: Row, index: number) => void;
  onRowOpen: (row: Row) => void;
  /** Right-click handler — pass a tile's row for a row menu, omit it for the empty-area menu. */
  onRowContext: (e: React.MouseEvent, row?: Row) => void;
  onClearSelection: () => void;
}): React.JSX.Element => {
  // Virtualized by ROW of tiles (same reason as the list — see FileList). The column count follows the
  // container's width, read through the gallery's own CSS so the tile size has one SSOT.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => setCols(galleryColumns(el));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rowCount = Math.ceil(rows.length / cols);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_ROW_ESTIMATE_PX,
    overscan: 3,
  });

  return (
  // click / right-click on the blank grid area (not a tile) clears the selection / opens the empty menu
  <div
    ref={scrollRef}
    className="cs-gallery"
    onClick={(e) => isBlankArea(e, ".cs-tile") && onClearSelection()}
    onContextMenu={(e) => isBlankArea(e, ".cs-tile") && onRowContext(e)}
  >
    <div className="cs-gallery-body" style={{ height: virtualizer.getTotalSize() }}>
    {virtualizer.getVirtualItems().map((item) => (
      <div
        key={item.key}
        ref={virtualizer.measureElement}
        data-index={item.index}
        className="cs-gallery-row"
        style={{ transform: `translateY(${item.start}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {rows.slice(item.index * cols, (item.index + 1) * cols).map((row, j) => {
          const i = item.index * cols + j;
          const key = rowKey(row);
          const isFolder = row.type === "folder";
          const src = drag.source(row);
          return (
            <button
              key={key}
              type="button"
              className={isFolder && drag.isDropTarget(row.path) ? "cs-tile cs-tile--drop" : "cs-tile"}
              aria-selected={selected.has(key)}
              draggable
              onDragStart={src.onDragStart}
              onDragEnd={src.onDragEnd}
              {...(isFolder ? drag.target(row.path) : {})}
              onClick={(e) => onRowClick(e, row, i)}
              onDoubleClick={() => onRowOpen(row)}
              onContextMenu={(e) => onRowContext(e, row)}
            >
              {/* file-type icon today; a real thumbnail when R2 lands (the only R2-gated piece) */}
              <span className="cs-tile-thumb">{row.type === "folder" ? <Icon name="folder" size={40} /> : <KindIcon kind={row.file.kind} size={40} />}</span>
              <span className="cs-tile-foot">
                <span className="cs-tile-name" title={row.name}>{row.name}</span>
                {!isEmptyFolder(row) && (
                  <StatusBadges badges={rowBadges(row)} reason={row.type === "file" ? failureReason(row.file) : null} />
                )}
              </span>
            </button>
          );
        })}
      </div>
    ))}
    </div>
  </div>
  );
};

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
      Choose files or folders
    </span>
  </button>
);

/** The tree is not a fact yet: say so, in the daemon's own words when it failed. Never the hero. */
const TreeStatus = ({ tree, onRetry }: { tree: TreeState; onRetry: () => void }): React.JSX.Element | null => {
  // "Connecting…" offers a Retry once it's clearly taking too long, so it can never be the dead-end spinner
  // with no recourse it was (2026-08-25, PILLAR5). Resets whenever the state changes.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(t);
  }, [tree.state]);

  if (tree.state === "connecting") {
    return slow ? (
      <EmptyState
        icon="cloud_sync"
        title="Connecting to your vault…"
        description="This is taking longer than usual. Your files are safe on our end."
        action={
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    ) : (
      <EmptyState icon="cloud_sync" title="Connecting to your vault…" />
    );
  }
  if (tree.state === "failed") {
    return (
      <EmptyState
        icon="cloud_off"
        title="Couldn't load your files"
        description={`Your files are safe — this is the list that failed to load: ${tree.reason}.`}
        action={
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  return null;
};

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
  // Can't move a folder into itself or its own subtree — the same legality the drag gesture enforces.
  const blocked = (p: string): boolean => !canMoveInto(targets, p);
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
