/**
 * The side-effecting glue between {@link ColdstoreApi} (window.coldstore) and the pure {@link Store}.
 * Subscribes to pushed events/lifecycle and dispatches them; issues the command-side reads that keep
 * the authoritative snapshot fresh (initial load, on (re)connect, and after `sourcesChanged`).
 *
 * Keep this the ONLY place in the renderer that calls `api.request` for state-syncing reads, so the
 * "what triggers a refetch" policy lives in one spot.
 */
import type { ColdstoreApi } from "../../../shared/ipc.ts";
import { eventAction } from "./reducer.ts";
import type { Store } from "./store.ts";

/** Wire an api to a store. Returns a disposer that detaches all subscriptions. */
export const connectController = (api: ColdstoreApi, store: Store): (() => void) => {
  const refreshStatus = async (): Promise<void> => {
    try {
      store.dispatch({ type: "statusLoaded", status: await api.request("getStatus") });
    } catch {
      /* drop/timeout — a lifecycle push will re-trigger a refresh on reconnect */
    }
  };

  const refreshSources = async (): Promise<void> => {
    try {
      store.dispatch({ type: "sourcesLoaded", sources: await api.request("listSources") });
    } catch {
      /* same as above */
    }
  };

  const refreshFiles = async (): Promise<void> => {
    try {
      store.dispatch({ type: "filesLoaded", files: await api.request("listFiles") });
    } catch {
      /* same as above */
    }
  };

  const refreshExcludes = async (): Promise<void> => {
    try {
      store.dispatch({ type: "excludesLoaded", excludes: await api.request("listExcludes") });
    } catch {
      /* same as above */
    }
  };

  // Pricing is a static rate card — fetch once per connect (no event invalidates it).
  const refreshPricing = async (): Promise<void> => {
    try {
      store.dispatch({ type: "pricingLoaded", pricing: await api.request("getPricing") });
    } catch {
      /* falls back to the seeded FALLBACK_PRICING already in state */
    }
  };

  const offEvent = api.onEvent((name, data) => {
    store.dispatch(eventAction(name, data));
    // Resync the authoritative snapshot when the daemon reports the registry or a run changed it.
    if (name === "sourcesChanged") void refreshSources();
    // An add/removeExclude changed the registry — re-read it (the next scan already applies the change).
    else if (name === "excludesChanged") void refreshExcludes();
    // A reorganize/delete (movePath/deletePath) rewrote the tree — re-read it to reconcile the optimistic edit.
    else if (name === "filesChanged") void refreshFiles();
    // A finished run may have archived new files / changed their status — re-read both the counts
    // (getStatus) and the tree (listFiles).
    else if (name === "runFinished") {
      void refreshStatus();
      void refreshFiles();
    }
  });

  const offLifecycle = api.onLifecycle((state) => {
    store.dispatch({ type: "connection", state });
    if (state === "connected") {
      void refreshStatus(); // resync the snapshot after a (re)connect
      void refreshFiles();
      void refreshExcludes();
      void refreshPricing();
    }
  });

  // First paint: read the current connection state and, if already connected, the snapshot + tree +
  // excludes + pricing.
  void (async () => {
    const state = await api.getConnectionState();
    store.dispatch({ type: "connection", state });
    if (state === "connected") {
      await Promise.all([refreshStatus(), refreshFiles(), refreshExcludes(), refreshPricing()]);
    }
  })();

  return () => {
    offEvent();
    offLifecycle();
  };
};
