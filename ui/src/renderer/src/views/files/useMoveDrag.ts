/**
 * Drag-to-move — the Finder gesture over the same journal move op as "Move to…" (`movePath`).
 *
 * Deliberately NATIVE HTML5 DnD, not a pointer-DnD library: the browser's hero gesture
 * (drop-to-upload) is already native OS file DnD, and one event model serves both. An internal row
 * drag is discriminated from an OS file drag by a private dataTransfer type ({@link MOVE_DRAG_TYPE}):
 * the upload overlay keys on `"Files"`, these handlers key on the private type, so neither gesture
 * can ever trigger the other. (A pointer-based library — dnd-kit et al — cannot see OS file drags at
 * all, so it would mean running two parallel DnD systems over one surface.)
 *
 * The dragged targets live in a ref, NOT in the dataTransfer payload: HTML5 protected mode hides the
 * data during dragover (only `types` is readable), and the drag never leaves this window anyway.
 * The hovered destination (`dropDir`) is real state so the folder row / tile / crumb can restyle.
 *
 * SPRING-LOADING (Finder's hold-to-open): keep a drag hovering a folder row/tile/crumb and after
 * {@link SPRING_OPEN_MS} it opens under the drag (`onOpen` → navigate), so any depth is reachable
 * mid-drag. The `--drop` CSS pulse is the "about to open" cue. This is also why the CURRENT directory
 * has a `background` drop target: after springing into a folder, releasing anywhere in the window
 * must land the items in THAT folder — without it, a spring-open would strand the drop.
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

/** Is this drag an internal row move (vs an OS file drag)? `types` is readable during dragover. */
export const isMoveDrag = (e: React.DragEvent): boolean =>
  e.dataTransfer.types.includes(MOVE_DRAG_TYPE);

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
  /** A folder row, folder tile, or ancestor breadcrumb crumb: accepts the drop AND spring-opens on hold. */
  target: (dir: string) => MoveDragTarget;
  /** The browser's blank area, standing in for the CURRENT directory: accepts the drop (so a release
   * after a spring-open lands "here"), but never spring-opens — it's already open. */
  background: (dir: string) => MoveDragTarget;
  /** Is `dir` the currently hovered, LEGAL destination? Drives the drop highlight. */
  isDropTarget: (dir: string) => boolean;
}

export const useMoveDrag = (opts: {
  /** The targets a drag of `row` carries — the whole selection when `row` is in it, else just `row`
   * (the caller also re-anchors the selection to `row` in that case, Finder-style). */
  targetsFor: (row: Row) => RowTarget[];
  /** Commit the move (the optimistic edit + the real daemon `movePath` per target). */
  onMove: (targets: RowTarget[], toDir: string) => void;
  /** Spring-open: navigate the browser into `dir` mid-drag (the view's `goTo`). */
  onOpen: (dir: string) => void;
}): MoveDrag => {
  const dragged = useRef<RowTarget[] | null>(null);
  const spring = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const docCleanup = useRef<(() => void) | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);

  const cancelSpring = (): void => {
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = null;
  };

  /** Idempotent end-of-drag reset — reachable from EVERY way a drag can end (see onDragStart). */
  const reset = (): void => {
    dragged.current = null;
    cancelSpring();
    setDropDir(null);
    docCleanup.current?.();
    docCleanup.current = null;
  };

  /** May the current drag land on `dir`? `explicit` targets (a folder row/tile/crumb the user is
   * pointing AT) also accept a no-op drop — Finder's "put it back where it came from" gesture; the
   * background only takes real moves, so an ordinary within-folder drag never lights the card up. */
  const allowed = (dir: string, explicit: boolean): boolean => {
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
    setDropDir(dir);
    if (springs && spring.current?.dir !== dir) {
      cancelSpring();
      spring.current = {
        dir,
        timer: setTimeout(() => {
          // Navigation unmounts these rows mid-drag; final cleanup rides the document-level hooks.
          spring.current = null;
          setDropDir(null);
          opts.onOpen(dir);
        }, SPRING_OPEN_MS),
      };
    }
  };

  /** The shared drop-accepting handlers. An `explicit` target (folder row/tile/crumb) spring-opens on
   * hold AND accepts a no-op put-back; the background does neither. */
  const dropTarget = (dir: string, explicit: boolean): MoveDragTarget => ({
    onDragEnter: (e) => {
      if (!isMoveDrag(e) || !allowed(dir, explicit)) return;
      e.stopPropagation(); // claim it — the background (current-dir) target must not overwrite the highlight
      claim(dir, explicit);
    },
    onDragOver: (e) => {
      if (!isMoveDrag(e) || !allowed(dir, explicit)) return; // no preventDefault → the drop is refused here
      e.preventDefault(); // "this is a valid drop target"
      e.stopPropagation(); // keep the container's file-drop dragover out of it
      e.dataTransfer.dropEffect = "move";
      claim(dir, explicit);
    },
    onDragLeave: (e) => {
      // Moving between a target's own children fires dragleave too — only clear the highlight (and
      // disarm the spring) when the pointer has truly left this element.
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      if (spring.current?.dir === dir) cancelSpring();
      setDropDir((cur) => (cur === dir ? null : cur));
    },
    onDrop: (e) => {
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
        // reset also rides document-level dragend/drop. Whichever path fires first wins (reset is
        // idempotent) and removes these listeners again.
        const onDocEnd = (): void => reset();
        document.addEventListener("dragend", onDocEnd);
        document.addEventListener("drop", onDocEnd);
        docCleanup.current = () => {
          document.removeEventListener("dragend", onDocEnd);
          document.removeEventListener("drop", onDocEnd);
        };
      },
      // Fires on the source when the drag ends ANYWHERE — drop, Esc, or an off-target release.
      onDragEnd: reset,
    }),
    target: (dir) => dropTarget(dir, true),
    background: (dir) => dropTarget(dir, false),
    isDropTarget: (dir) => dropDir === dir,
  };
};
