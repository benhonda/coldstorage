/**
 * A tiny observable store wrapping the pure {@link reducer}. State is immutable — `getState` returns
 * the same reference until the next dispatch — so React's `useSyncExternalStore` can use it directly
 * without tearing or render loops. No framework dependency: layer 3 (React) just binds to it.
 */
import { initialState, reducer, type Action, type AppState } from "./reducer.ts";

export type { AppState } from "./reducer.ts";

/** How long `dispatchCoalesced` gathers actions before folding them in one notify — one frame. */
const COALESCE_MS = 16;

export interface Store {
  getState(): AppState;
  /** Subscribe to changes; returns an unsubscribe fn. Matches `useSyncExternalStore`'s shape. */
  subscribe(onChange: () => void): () => void;
  /** Fold `action` now. Anything queued by {@link dispatchCoalesced} is folded first, so the fold order
   * is always the arrival order — a snapshot read never overtakes the events that prompted it. */
  dispatch(action: Action): void;
  /**
   * Fold `action` with everything else that arrives in the same frame, then notify ONCE.
   *
   * For the daemon's event stream. A run publishes `fileArchived` / `uploadProgress` / `runProgress` per
   * file, per part, per link — a 5k-file deposit is well over ten thousand events, and each one arrives
   * as its own IPC task, so React's automatic batching never sees two together: every event was a full
   * re-render of the app. Subscribers can't repaint faster than a frame anyway, so folding a frame's
   * worth at a time loses nothing they could have shown.
   */
  dispatchCoalesced(action: Action): void;
}

export const createStore = (initial: AppState = initialState): Store => {
  let state = initial;
  const listeners = new Set<() => void>();
  let pending: Action[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    for (const l of listeners) l();
  };

  /** Fold every queued action, notifying once if any of them changed the state. */
  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending.length === 0) return;
    const queued = pending;
    pending = [];
    const before = state;
    for (const action of queued) state = reducer(state, action);
    if (state !== before) notify();
  };

  return {
    getState: () => state,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    dispatch: (action) => {
      flush();
      const next = reducer(state, action);
      if (next === state) return; // reducer returned unchanged — skip the notify
      state = next;
      notify();
    },
    dispatchCoalesced: (action) => {
      pending.push(action);
      flushTimer ??= setTimeout(flush, COALESCE_MS);
    },
  };
};
