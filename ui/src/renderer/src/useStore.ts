import { useSyncExternalStore } from "react";
import type { AppState, Store } from "./state/store.ts";

/**
 * Bind a component to the store. `getState` returns a stable reference between dispatches, so this is
 * tear-free with no selector memoization needed — components read the whole state and destructure.
 */
export const useAppState = (store: Store): AppState =>
  useSyncExternalStore(store.subscribe, store.getState);
