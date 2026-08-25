/**
 * Drag targets for the file browser — BOTH gestures over one set of folder rows / tiles / crumbs:
 *  - drag-to-move: an internal row drag, the Finder gesture over the same journal move op as
 *    "Move to…" (`movePath`);
 *  - drop-to-upload INTO a folder: an OS file drag released on a folder deposits there, not into
 *    whatever folder happens to be open (the browser's blank area is still "into this folder").
 *
 * Deliberately NATIVE HTML5 DnD, not a pointer-DnD library: the browser's hero gesture
 * (drop-to-upload) is already native OS file DnD, and one event model serves both. An internal row
 * drag is discriminated from an OS file drag by a private dataTransfer type ({@link MOVE_DRAG_TYPE})
 * vs the browser's `"Files"` type, so neither gesture can ever be mistaken for the other. (A
 * pointer-based library — dnd-kit et al — cannot see OS file drags at all, so it would mean running
 * two parallel DnD systems over one surface.)
 *
 * The dragged targets live in a ref, NOT in the dataTransfer payload: HTML5 protected mode hides the
 * data during dragover (only `types` is readable), and the drag never leaves this window anyway.
 * The hovered destination (`dropDir`) is real state so the folder row / tile / crumb can restyle.
 *
 * SPRING-LOADING (Finder's hold-to-open): keep a drag hovering a folder row/tile/crumb and after
 * {@link SPRING_OPEN_MS} it opens under the drag (`onOpen` → navigate), so any depth is reachable
 * mid-drag. The `--drop` CSS pulse is the "about to open" cue. This is also why the CURRENT directory
 * has a `background` drop target: after springing into a folder, releasing anywhere in the window
 * must land the items in THAT folder — without it, a spring-open would strand the drop. Back / Forward
 * are `hold` targets: the same hold fires them (Finder does this too), but they accept no drop.
 *
 * ENDING A DRAG is where native DnD is least reliable: Esc, a release outside the window, or a
 * spring-open unmounting the source can each skip `dragend` / the matching `dragleave`, stranding the
 * highlight, the drop frame, or — worst — a live spring timer that navigates AFTER the user bailed.
 * So every drag is also watched by a heartbeat: `dragover` keeps firing while a drag is alive (the
 * spec mandates it even when the pointer is still), and when it stops for {@link DRAG_DEAD_MS} the
 * drag is over, however it ended. `reset` is the one end-of-drag path, and it's idempotent.
 */
import { useRef, useState } from "react";
import { type Row, type RowTarget, canMoveInto, moveIsNoop } from "./model.ts";

/** The private dataTransfer type marking an internal row drag (the payload itself stays in React). */
export const MOVE_DRAG_TYPE = "application/x-coldstorage-move";

/** How long a drag must HOLD over a folder/crumb before it spring-opens (Finder's hold-to-open).
 * A deliberate hold, not a pause — passing over folders while aiming elsewhere must never open them,
 * and even a moment's hesitation shouldn't. The `--drop` pulse (see app.css) starts partway into
 * this hold as the "about to open" cue. */
const SPRING_OPEN_MS = 1500;

/** No `dragover` for this long = the drag is over (Esc, released off-window, …). The spec fires
 * dragover every 350ms ±200ms while stationary, so this is a comfortable multiple, and well under
 * SPRING_OPEN_MS — a cancelled drag can never reach a spring-open. */
const DRAG_DEAD_MS = 900;

/** Is this drag an internal row move (vs an OS file drag)? `types` is readable during dragover. */
export const isMoveDrag = (e: React.DragEvent): boolean =>
  e.dataTransfer.types.includes(MOVE_DRAG_TYPE);

/** Is this an OS file drag (Finder → the app)? The payload (`files`) is only readable on drop. */
export const isFileDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes("Files");

/**
 * Every drag ghosts as a Finder-style pill — the item's name for one, "N items" for many — instead
 * of the browser's default full-row snapshot (which reads heavy and whose opacity we can't control).
 * The badge must be in the DOM and rendered when `setDragImage` snapshots it, so it's parked
 * offscreen (see `.cs-drag-badge`) and removed on the next tick.
 */
const dragBadge = (e: React.DragEvent, label: string): void => {
  const badge = document.createElement("div");
  badge.className = "cs-drag-badge";
  badge.textContent = label;
  document.body.appendChild(badge);
  e.dataTransfer.setDragImage(badge, 16, 16);
  setTimeout(() => badge.remove(), 0);
};

/** Drag handlers for a row/tile (pair with `draggable` on the element). */
export interface MoveDragSource {
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

/** Drop handlers for a destination that accepts a move. */
export interface MoveDragTarget {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export interface MoveDrag {
  source: (row: Row) => MoveDragSource;
  /** A folder row, folder tile, or ancestor breadcrumb crumb: accepts a row move OR an OS file drop
   * into `dir`, AND spring-opens on hold. */
  target: (dir: string) => MoveDragTarget;
  /** The browser's blank area, standing in for the CURRENT directory: accepts a row-move drop (so a
   * release after a spring-open lands "here"), but never spring-opens — it's already open. OS file
   * drops on the background are the container's own drop-to-upload (it deposits into the open dir). */
  background: (dir: string) => MoveDragTarget;
  /** Is `dir` the currently hovered, LEGAL destination? Drives the drop highlight. */
  isDropTarget: (dir: string) => boolean;
  /** A hold-to-fire control that accepts NO drop — Back / Forward. Holding a drag over it for the
   * spring delay fires `fire` (navigate), exactly like holding over a folder opens it. */
  hold: (key: string, fire: () => void) => MoveDragTarget;
  /** Is the `hold` control `key` armed (a drag is holding over it)? Drives its pulse. */
  isHolding: (key: string) => boolean;
  /** Call from the browser container's dragenter/dragover so the heartbeat watches EVERY drag over
   * the surface — an OS file drag has no dragstart of ours to hook. */
  track: () => void;
}

export const useMoveDrag = (opts: {
  /** The targets a drag of `row` carries — the whole selection when `row` is in it, else just `row`
   * (the caller also re-anchors the selection to `row` in that case, Finder-style). */
  targetsFor: (row: Row) => RowTarget[];
  /** Commit the move (the optimistic edit + the real daemon `movePath` per target). */
  onMove: (targets: RowTarget[], toDir: string) => void;
  /** Spring-open: navigate the browser into `dir` mid-drag (the view's `goTo`). */
  onOpen: (dir: string) => void;
  /** An OS file drag released on an explicit folder target: deposit `files` into `dir`. */
  onDropFiles: (files: File[], dir: string) => void;
  /** The drag is over — by drop, Esc, or leaving the window (the heartbeat's verdict). The view takes
   * its own drop frame down here. */
  onDragEnded: () => void;
}): MoveDrag => {
  const dragged = useRef<RowTarget[] | null>(null);
  const spring = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const docCleanup = useRef<(() => void) | null>(null);
  const heartbeat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [holdKey, setHoldKey] = useState<string | null>(null);

  const cancelSpring = (): void => {
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = null;
  };

  /** Idempotent end-of-drag reset — reachable from EVERY way a drag can end (see the header). */
  const reset = (): void => {
    dragged.current = null;
    cancelSpring();
    setDropDir(null);
    setHoldKey(null);
    if (heartbeat.current) clearTimeout(heartbeat.current);
    heartbeat.current = null;
    docCleanup.current?.();
    docCleanup.current = null;
    opts.onDragEnded();
  };

  /** The heartbeat: (re)arm the dead-drag timer, and on the first beat of a drag hook the document
   * for the ways it can end that the source/targets won't hear about. */
  const track = (): void => {
    if (heartbeat.current) clearTimeout(heartbeat.current);
    heartbeat.current = setTimeout(reset, DRAG_DEAD_MS);
    if (docCleanup.current) return;
    const beat = (): void => {
      if (heartbeat.current) clearTimeout(heartbeat.current);
      heartbeat.current = setTimeout(reset, DRAG_DEAD_MS);
    };
    // Esc: Chromium cancels the drag and MAY skip dragend / dragleave; the heartbeat would catch it
    // ~1s later, but if the key event reaches us at all we can end it now.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") reset();
    };
    document.addEventListener("dragover", beat);
    document.addEventListener("dragend", reset);
    document.addEventListener("drop", reset);
    document.addEventListener("keydown", onKey);
    docCleanup.current = () => {
      document.removeEventListener("dragover", beat);
      document.removeEventListener("dragend", reset);
      document.removeEventListener("drop", reset);
      document.removeEventListener("keydown", onKey);
    };
  };

  /** May the current drag land on `dir`? `explicit` targets (a folder row/tile/crumb the user is
   * pointing AT) also accept a no-op drop — Finder's "put it back where it came from" gesture; the
   * background only takes real moves, so an ordinary within-folder drag never lights the card up.
   * An OS file drag lands on any explicit folder (it can't cycle — nothing in the vault is moving). */
  const allowed = (e: React.DragEvent, dir: string, explicit: boolean): boolean => {
    if (isFileDrag(e)) return explicit;
    if (!isMoveDrag(e)) return false;
    const t = dragged.current;
    return t !== null && canMoveInto(t, dir) && (explicit || !moveIsNoop(t, dir));
  };

  /** Take the highlight (and arm hold-to-open) for `dir`. Runs from BOTH dragenter and dragover:
   * after a spring-open swaps the rows mid-drag, Chromium won't re-fire dragenter on whatever now
   * sits under the stationary pointer, but dragover keeps firing — so claiming here too is what makes
   * chain-springing (folder → subfolder → …) work without wiggling the mouse. Cheap on repeat:
   * setDropDir bails out on the same value, and the spring arms once per target (re-entering a child
   * of the same element must not restart the clock). */
  const claim = (dir: string, springs: boolean): void => {
    track();
    setDropDir(dir);
    if (springs) arm(dir, () => opts.onOpen(dir));
  };

  /** Arm hold-to-fire for `key` (once per key — re-entering a child must not restart the clock). */
  const arm = (key: string, fire: () => void): void => {
    if (spring.current?.key === key) return;
    cancelSpring();
    spring.current = {
      key,
      timer: setTimeout(() => {
        // Navigation unmounts these rows mid-drag; final cleanup rides the document-level hooks.
        spring.current = null;
        setDropDir(null);
        setHoldKey(null);
        fire();
      }, SPRING_OPEN_MS),
    };
  };

  /** The shared drop-accepting handlers. An `explicit` target (folder row/tile/crumb) spring-opens on
   * hold, accepts a no-op put-back, and takes an OS file drop; the background does none of those. */
  const dropTarget = (dir: string, explicit: boolean): MoveDragTarget => ({
    onDragEnter: (e) => {
      if (!allowed(e, dir, explicit)) return;
      // Claim it — the background (current-dir) target must not overwrite the highlight. A FILE drag
      // keeps bubbling: the container counts enter/leave pairs to show its drop frame, and swallowing
      // one side of a pair would strand the frame open after the drag leaves the window.
      if (isMoveDrag(e)) e.stopPropagation();
      claim(dir, explicit);
    },
    onDragOver: (e) => {
      if (!allowed(e, dir, explicit)) return; // no preventDefault → the drop is refused here
      e.preventDefault(); // "this is a valid drop target"
      e.stopPropagation(); // keep the container's file-drop dragover out of it
      e.dataTransfer.dropEffect = isFileDrag(e) ? "copy" : "move";
      claim(dir, explicit);
    },
    onDragLeave: (e) => {
      // Moving between a target's own children fires dragleave too — only clear the highlight (and
      // disarm the spring) when the pointer has truly left this element.
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      if (spring.current?.key === dir) cancelSpring();
      setDropDir((cur) => (cur === dir ? null : cur));
    },
    onDrop: (e) => {
      if (isFileDrag(e)) {
        if (!explicit) return; // the container's own onDrop uploads into the open dir
        e.preventDefault();
        e.stopPropagation(); // the container must not ALSO deposit these into the open dir
        const files = [...e.dataTransfer.files];
        reset();
        opts.onDropFiles(files, dir);
        return;
      }
      if (!isMoveDrag(e)) return;
      e.preventDefault();
      e.stopPropagation(); // never fall through to drop-to-upload
      const targets = dragged.current;
      reset();
      // An explicit no-op drop still "lands" (put-back feels accepted); onMove skips the unchanged ones.
      if (targets && canMoveInto(targets, dir) && (explicit || !moveIsNoop(targets, dir)))
        opts.onMove(targets, dir);
    },
  });

  return {
    source: (row) => ({
      onDragStart: (e) => {
        const targets = opts.targetsFor(row);
        dragged.current = targets;
        e.dataTransfer.setData(MOVE_DRAG_TYPE, ""); // the marker; the payload stays in the ref
        e.dataTransfer.effectAllowed = "move";
        dragBadge(e, targets.length > 1 ? `${targets.length} items` : row.name);
        // A spring-open unmounts the source row mid-drag, and Chromium then skips its dragend — so the
        // end of the drag also rides the document-level hooks + heartbeat that `track` installs.
        track();
      },
      // Fires on the source when the drag ends ANYWHERE — drop, Esc, or an off-target release.
      onDragEnd: reset,
    }),
    target: (dir) => dropTarget(dir, true),
    background: (dir) => dropTarget(dir, false),
    isDropTarget: (dir) => dropDir === dir,
    hold: (key, fire) => ({
      // No preventDefault anywhere: the drop stays refused (no-drop cursor), only the hold counts.
      // Either drag kind may hold — a row move wants Back as much as a Finder drag does.
      onDragEnter: (e) => {
        if (!isMoveDrag(e) && !isFileDrag(e)) return;
        track();
        setHoldKey(key);
        arm(key, fire);
      },
      onDragOver: (e) => {
        if (!isMoveDrag(e) && !isFileDrag(e)) return;
        track();
        setHoldKey(key);
        arm(key, fire);
      },
      onDragLeave: (e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        if (spring.current?.key === key) cancelSpring();
        setHoldKey((cur) => (cur === key ? null : cur));
      },
      onDrop: () => {},
    }),
    isHolding: (key) => holdKey === key,
    track,
  };
};
