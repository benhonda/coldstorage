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
  /**
   * Run one state-syncing read and swallow its rejection — a refetch that fails must never reject into
   * an unhandled promise, and a transient drop is not a user-facing error.
   *
   * But swallow LOUDLY. These four reads are the only path by which daemon truth reaches the UI, and a
   * failed one leaves its slice stale or empty indefinitely: the recovery is a lifecycle push, so a
   * failure that isn't a disconnect never retries at all. Silent was the expensive part of the 2026-07-18
   * storage-figure bug — the UI showed nothing, forever, with no error, no retry and no log to find. The
   * console line is for whoever debugs the next one; `what` names the slice so the message says which.
   */
  const syncing = async (what: string, read: () => Promise<void>): Promise<void> => {
    try {
      await read();
    } catch (e) {
      console.error(`[coldstore] ${what} refresh failed — this slice is now stale until the next resync:`, e);
    }
  };

  const refreshStatus = (): Promise<void> =>
    syncing("status", async () => store.dispatch({ type: "statusLoaded", status: await api.request("getStatus") }));

  const refreshSources = (): Promise<void> =>
    syncing("sources", async () => store.dispatch({ type: "sourcesLoaded", sources: await api.request("listSources") }));

  const refreshFiles = (): Promise<void> =>
    syncing("files", async () => store.dispatch({ type: "filesLoaded", files: await api.request("listFiles") }));

  const refreshExcludes = (): Promise<void> =>
    syncing("excludes", async () => store.dispatch({ type: "excludesLoaded", excludes: await api.request("listExcludes") }));


  const offEvent = api.onEvent((name, data) => {
    store.dispatch(eventAction(name, data));
    // Resync the authoritative snapshot when the daemon reports the registry or a run changed it.
    if (name === "sourcesChanged") void refreshSources();
    // An add/removeExclude changed the registry — re-read it (the next scan already applies the change).
    else if (name === "excludesChanged") void refreshExcludes();
    // A reorganize/delete (movePath/deletePath) rewrote the tree — re-read it to reconcile the optimistic edit.
    // ALSO the daemon's session-established push (`beginSession`), which is the only signal that a
    // `getStatus` taken earlier is now stale. The connect→refresh at the bottom of this file routinely
    // beats `authenticate` (main has a keychain/network round trip to do first), and a session-less
    // getStatus answers SUCCESSFULLY with `signedIn: false, bytesStored: null` rather than erroring — so
    // nothing looked broken and nothing retried. The storage figures then stayed empty until the next
    // `runFinished`, up to COLDSTORE_INTERVAL (300 s) later. Re-reading the snapshot here costs one cheap
    // call on an event that is already a resync, and closes that window.
    else if (name === "filesChanged") {
      void refreshStatus();
      void refreshFiles();
    }
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
    }
  });

  // Sign-in + vault + entitlement status are push-driven from main (no daemon involved); plain replaces.
  const offAuth = api.onAuthStatus((auth) => store.dispatch({ type: "authChanged", auth }));
  const offVault = api.onVaultStatus((vault) => store.dispatch({ type: "vaultChanged", vault }));
  const offAccount = api.onAccount((account) => store.dispatch({ type: "accountChanged", account }));
  const offEntitlement = api.onEntitlement((entitlement) => store.dispatch({ type: "entitlementChanged", entitlement }));
  const offUpdate = api.onUpdateStatus((update) => store.dispatch({ type: "updateChanged", update }));

  // First paint: read the current connection + sign-in state and, if already connected, the snapshot
  // + tree + excludes.
  void (async () => {
    const [state, auth, vault, account, entitlement, update] = await Promise.all([
      api.getConnectionState(),
      api.getAuthStatus(),
      api.getVaultStatus(),
      api.getAccount(),
      api.getEntitlement(),
      api.getUpdateStatus(),
    ]);
    store.dispatch({ type: "connection", state });
    store.dispatch({ type: "authChanged", auth });
    store.dispatch({ type: "vaultChanged", vault });
    store.dispatch({ type: "accountChanged", account });
    store.dispatch({ type: "entitlementChanged", entitlement });
    store.dispatch({ type: "updateChanged", update });
    // We now know the real sign-in/vault state — drop the "checking…" gate. Done before the (slower)
    // connected refreshes so the right screen paints as soon as the auth answer is in.
    store.dispatch({ type: "initialized" });
    if (state === "connected") {
      await Promise.all([refreshStatus(), refreshFiles(), refreshExcludes()]);
    }
  })();

  return () => {
    offEvent();
    offLifecycle();
    offAuth();
    offVault();
    offAccount();
    offEntitlement();
    offUpdate();
  };
};
