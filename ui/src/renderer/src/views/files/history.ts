/**
 * Browser-style navigation history for the file explorer — the pure model behind the Back / Forward
 * buttons. Immutable: every op returns a new value, so it slots straight into `useState`.
 *
 * Semantics match a web browser: {@link push} truncates any forward entries (going back then
 * somewhere new forgets the old future); {@link back} / {@link forward} move the cursor without
 * dropping entries. Pushing the current dir again is a no-op, so re-clicking the current crumb or
 * spring-loading into the folder you're already in never pads the stack.
 */
export interface NavHistory {
  /** Every visited dir, oldest first. Never empty — index 0 is where the view opened. */
  readonly entries: readonly string[];
  /** Cursor into `entries`; `entries[index]` is the current dir. */
  readonly index: number;
}

export const initialHistory = (dir = ""): NavHistory => ({ entries: [dir], index: 0 });

export const currentDir = (h: NavHistory): string => h.entries[h.index] ?? "";
export const canGoBack = (h: NavHistory): boolean => h.index > 0;
export const canGoForward = (h: NavHistory): boolean => h.index < h.entries.length - 1;

export const push = (h: NavHistory, dir: string): NavHistory => {
  if (dir === currentDir(h)) return h;
  const entries = [...h.entries.slice(0, h.index + 1), dir];
  return { entries, index: entries.length - 1 };
};

export const back = (h: NavHistory): NavHistory => (canGoBack(h) ? { ...h, index: h.index - 1 } : h);
export const forward = (h: NavHistory): NavHistory => (canGoForward(h) ? { ...h, index: h.index + 1 } : h);

/**
 * A folder that was renamed/moved/deleted may still sit in the history. Rewrite every entry through
 * `map` (identity for untouched paths, `null` for a dir that no longer exists) so Back never lands on
 * a path that isn't there. Vanished entries are dropped and adjacent duplicates collapsed; the cursor
 * follows its entry, or the nearest survivor before it.
 */
export const remapHistory = (h: NavHistory, map: (dir: string) => string | null): NavHistory => {
  const entries: string[] = [];
  let index = 0;
  h.entries.forEach((dir, i) => {
    const next = map(dir);
    const dropped = next === null || next === entries.at(-1);
    if (!dropped) entries.push(next);
    // The cursor sticks to its own (surviving) entry; if that entry vanished, to whatever precedes it.
    if (i <= h.index) index = Math.max(0, entries.length - 1);
  });
  if (entries.length === 0) return initialHistory();
  return { entries, index };
};
