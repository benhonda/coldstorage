/**
 * A tiny observable store wrapping the pure {@link reducer}. State is immutable — `getState` returns
 * the same reference until the next dispatch — so React's `useSyncExternalStore` can use it directly
 * without tearing or render loops. No framework dependency: layer 3 (React) just binds to it.
 */
import { initialState, reducer, type Action, type AppState } from "./reducer.ts";

export type { AppState } from "./reducer.ts";

export interface Store {
  getState(): AppState;
  /** Subscribe to changes; returns an unsubscribe fn. Matches `useSyncExternalStore`'s shape. */
  subscribe(onChange: () => void): () => void;
  dispatch(action: Action): void;
}

export const createStore = (initial: AppState = initialState): Store => {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    dispatch: (action) => {
      const next = reducer(state, action);
      if (next === state) return; // reducer returned unchanged — skip the notify
      state = next;
      for (const l of listeners) l();
    },
  };
};
