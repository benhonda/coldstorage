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
/** What `connectController` hands back: the teardown, plus the one refetch a view may ask for by hand
 * (the file browser's "Retry" when a tree read failed). Everything else stays event-driven. */
export interface Controller {
  dispose: () => void;
  refreshFiles: () => Promise<void>;
}

export const connectController = (api: ColdstoreApi, store: Store): Controller => {
  /**
   * Run one state-syncing read and swallow its rejection — a refetch that fails must never reject into
   * an unhandled promise, and a transient drop is not a user-facing error.
   *
   * But swallow LOUDLY. These reads are the only path by which daemon truth reaches the UI, and a
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

  // The one read whose failure is ALSO state: the browser has to be able to say "couldn't load your files"
  // instead of rendering the empty-vault hero over a stale or empty slice (see `AppState.filesLoad`).
  const refreshFiles = (): Promise<void> =>
    syncing("files", async () => {
      try {
        store.dispatch({ type: "filesLoaded", files: await api.request("listFiles") });
      } catch (e) {
        store.dispatch({ type: "filesLoadFailed", error: e instanceof Error ? e.message : String(e) });
        throw e; // `syncing` still logs it
      }
    });

  const refreshExcludes = (): Promise<void> =>
    syncing("excludes", async () => store.dispatch({ type: "excludesLoaded", excludes: await api.request("listExcludes") }));

  // The opt-in exclude packs. A STATIC catalogue (it has no user state in it — whether a pack is on is
  // derived from `excludes`), so unlike every other read here it can't go stale: fetched once per
  // connection, never re-read on an event.
  const refreshExcludeSuggestions = (): Promise<void> =>
    syncing("excludeSuggestions", async () =>
      store.dispatch({ type: "excludeSuggestionsLoaded", suggestions: await api.request("listExcludeSuggestions") }),
    );

  const refreshRestores = (): Promise<void> =>
    syncing("restores", async () => store.dispatch({ type: "restoresLoaded", restores: await api.request("listRestores") }));


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
    // Excludes have the identical soft-fail shape: a session-less `listExcludes` answers SUCCESSFULLY
    // with `[]`, so a pre-auth read is indistinguishable from "the user deleted all five defaults" and
    // nothing ever retried — the card stayed empty for the whole session. Same for an account switch,
    // where the reducer clears the slice and `beginSession` is again the only signal it's refillable.
    else if (name === "filesChanged") {
      void refreshStatus();
      void refreshFiles();
      void refreshExcludes();
      // Downloads too — and this line is the fix for a real bug. `beginSession` publishes `filesChanged`,
      // so this is the sign-in resync: sign out and back in, and the in-flight downloads must come BACK.
      // They used to vanish for good (renderer-held, cleared by `authChanged`), leaving a file the user had
      // paid to retrieve showing a plain green "Stored" ✓.
      void refreshRestores();
    }
    // A finished run may have archived new files / changed their status — re-read both the counts
    // (getStatus) and the tree (listFiles).
    else if (name === "runFinished") {
      void refreshStatus();
      void refreshFiles();
    }
    // A download moved (or finished). One event for the whole list — we re-read it rather than patch a
    // local copy, because the daemon's journal is the only thing that knows where a download really stands.
    else if (name === "restoresChanged" || name === "restoreCompleted") void refreshRestores();
    // The background S3 usage listing landed. `getStatus` serves `bytesStored` from that cache and never
    // waits on the listing, so this event is the ONLY thing that turns the meter's skeleton into a number
    // before the next run finishes (the 2026-08-25 non-blocking change had no such signal, and the meter
    // stayed pending for the whole session).
    else if (name === "usageChanged") void refreshStatus();
  });

  const offLifecycle = api.onLifecycle((state) => {
    store.dispatch({ type: "connection", state });
    if (state === "connected") {
      void refreshStatus(); // resync the snapshot after a (re)connect
      void refreshFiles();
      void refreshExcludes();
      void refreshExcludeSuggestions();
      void refreshRestores();
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
    const [state, auth, vault, account, entitlement, update, appInfo] = await Promise.all([
      api.getConnectionState(),
      api.getAuthStatus(),
      api.getVaultStatus(),
      api.getAccount(),
      api.getEntitlement(),
      api.getUpdateStatus(),
      api.getAppInfo(),
    ]);
    store.dispatch({ type: "connection", state });
    store.dispatch({ type: "authChanged", auth });
    store.dispatch({ type: "vaultChanged", vault });
    store.dispatch({ type: "accountChanged", account });
    store.dispatch({ type: "entitlementChanged", entitlement });
    store.dispatch({ type: "updateChanged", update });
    // Static for the process — read once here with the rest of first paint, never re-read.
    store.dispatch({ type: "appInfoLoaded", appInfo });
    // We now know the real sign-in/vault state — drop the "checking…" gate. Done before the (slower)
    // connected refreshes so the right screen paints as soon as the auth answer is in.
    store.dispatch({ type: "initialized" });
    if (state === "connected") {
      await Promise.all([refreshStatus(), refreshFiles(), refreshExcludes(), refreshExcludeSuggestions(), refreshRestores()]);
    }
  })();

  return {
    dispose: () => {
      offEvent();
      offLifecycle();
      offAuth();
      offVault();
      offAccount();
      offEntitlement();
      offUpdate();
    },
    refreshFiles,
  };
};
