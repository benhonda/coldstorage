/**
 * Headless test of the controller's sync policy (no Electron). A fake {@link ColdstoreApi} stands in
 * for `window.coldstore` so we can fire lifecycle/events and assert the real controller drives the
 * real store correctly: initial fetch, refetch-on-(re)connect, and sourcesChanged → listSources.
 */
import { describe, expect, test } from "bun:test";
import type { AccountStatus, AuthStatus, ColdstoreApi, ConnectionState, EntitlementStatus, ListedFile, Source, Status, UpdateStatus, VaultStatus } from "../../../shared/ipc.ts";
import { connectController } from "./controller.ts";
import { createStore } from "./store.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const status = (sources: Source[]): Status => ({
  filesTotal: 1,
  filesArchived: 1,
  blobsVerified: 1,
  running: false,
  permanentlyFailedBlobs: 0,
  sources,
});

/** A controllable fake of the preload surface. */
const makeApi = (initial: ConnectionState) => {
  let connectionState = initial;
  let sources: Source[] = [{ id: "s1", kind: "folder", path: "/a", mountPath: "a", paused: false }];
  let files: ListedFile[] = [{ id: "f1", relativePath: "a/b.jpg", size: 10, status: "archived", blobId: "blob-1", date: null }];
  const calls: string[] = [];
  let eventCb: ((name: never, data: never) => void) | null = null;
  let lifeCb: ((s: ConnectionState) => void) | null = null;
  let authCb: ((s: AuthStatus) => void) | null = null;
  let vaultCb: ((s: VaultStatus) => void) | null = null;
  let accountCb: ((s: AccountStatus) => void) | null = null;
  let entCb: ((s: EntitlementStatus) => void) | null = null;
  let updateCb: ((s: UpdateStatus) => void) | null = null;

  const api: ColdstoreApi = {
    request: ((method: string) => {
      calls.push(method);
      if (method === "getStatus") return Promise.resolve(status(sources));
      if (method === "listSources") return Promise.resolve(sources);
      if (method === "listFiles") return Promise.resolve(files);
      return Promise.resolve({ ok: true });
    }) as ColdstoreApi["request"],
    getConnectionState: () => Promise.resolve(connectionState),
    onEvent: (cb) => {
      eventCb = cb as typeof eventCb;
      return () => (eventCb = null);
    },
    onLifecycle: (cb) => {
      lifeCb = cb;
      return () => (lifeCb = null);
    },
    chooseFolder: () => Promise.resolve(null),
    getDownloadsDir: () => Promise.resolve("/tmp/Downloads"),
    pathForFile: () => "",
    getAuthStatus: () => Promise.resolve({ configured: false, state: "signedOut", email: null, name: null, error: null, emailAvailable: false }),
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    startEmailSignIn: () => Promise.resolve(),
    submitEmailCode: () => Promise.resolve(),
    cancelEmailSignIn: () => Promise.resolve(),
    onAuthStatus: (cb) => {
      authCb = cb;
      return () => (authCb = null);
    },
    getVaultStatus: () => Promise.resolve({ state: "locked", recoveryCode: null, error: null }),
    submitRecoveryCode: () => Promise.resolve(),
    acknowledgeRecoveryCode: () => Promise.resolve(),
    reissueRecoveryCode: () => Promise.resolve(),
    onVaultStatus: (cb) => {
      vaultCb = cb;
      return () => (vaultCb = null);
    },
    getAccount: () => Promise.resolve({ known: false, displayName: null, onboarded: false, recoveryCodeConfirmed: false, error: null }),
    setDisplayName: () => Promise.resolve(),
    submitSurvey: () => Promise.resolve(),
    completeOnboarding: () => Promise.resolve(),
    confirmRecoveryCode: () => Promise.resolve(),
    onAccount: (cb) => {
      accountCb = cb;
      return () => (accountCb = null);
    },
    getEntitlement: () => Promise.resolve({ known: false, active: false, checkingOut: false, quotaBytes: null, error: null }),
    subscribe: () => Promise.resolve(),
    onEntitlement: (cb) => {
      entCb = cb;
      return () => (entCb = null);
    },
    getUpdateStatus: () => Promise.resolve({ state: "idle", version: null, percent: null, error: null }),
    checkForUpdate: () => Promise.resolve(),
    restartToUpdate: () => Promise.resolve(),
    onUpdateStatus: (cb) => {
      updateCb = cb;
      return () => (updateCb = null);
    },
  };

  return {
    api,
    calls,
    setSources: (s: Source[]) => (sources = s),
    setFiles: (f: ListedFile[]) => (files = f),
    fireLifecycle: (s: ConnectionState) => {
      connectionState = s;
      lifeCb?.(s);
    },
    fireEvent: (name: string, data: Record<string, string>) =>
      eventCb?.(name as never, data as never),
    fireAuth: (s: AuthStatus) => authCb?.(s),
    fireVault: (s: VaultStatus) => vaultCb?.(s),
    fireAccount: (s: AccountStatus) => accountCb?.(s),
    fireEntitlement: (s: EntitlementStatus) => entCb?.(s),
    fireUpdate: (s: UpdateStatus) => updateCb?.(s),
  };
};

describe("controller sync policy", () => {
  test("fetches the snapshot on initial connect", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(f.calls).toContain("getStatus");
    expect(store.getState().status?.sources).toHaveLength(1);
    expect(store.getState().connection).toBe("connected");
  });

  test("loads the file tree (listFiles) on initial connect", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(f.calls).toContain("listFiles");
    expect(store.getState().files).toHaveLength(1);
    expect(store.getState().files[0]?.relativePath).toBe("a/b.jpg");
  });

  test("runFinished refetches the file tree (new files may be archived)", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    const before = f.calls.filter((c) => c === "listFiles").length;

    f.setFiles([
      { id: "f1", relativePath: "a/b.jpg", size: 10, status: "archived", blobId: "blob-1", date: null },
      { id: "f2", relativePath: "a/c.jpg", size: 20, status: "archived", blobId: "blob-2", date: null },
    ]);
    f.fireEvent("runFinished", { filesArchived: "2", filesTotal: "2", blobsFailed: "0" });
    await tick();
    expect(f.calls.filter((c) => c === "listFiles").length).toBe(before + 1);
    expect(store.getState().files).toHaveLength(2);
  });

  test("filesChanged refetches the file tree (a reorganize/delete rewrote it)", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    const before = f.calls.filter((c) => c === "listFiles").length;

    f.setFiles([{ id: "f1", relativePath: "moved/b.jpg", size: 10, status: "archived", blobId: "blob-1", date: null }]);
    f.fireEvent("filesChanged", { moved: "a/b.jpg", to: "moved/b.jpg" });
    await tick();
    expect(f.calls.filter((c) => c === "listFiles").length).toBe(before + 1);
    expect(store.getState().files[0]?.relativePath).toBe("moved/b.jpg");
  });

  test("does NOT fetch while disconnected, then refetches on (re)connect", async () => {
    const f = makeApi("disconnected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(f.calls).not.toContain("getStatus");

    f.fireLifecycle("connected");
    await tick();
    expect(f.calls).toContain("getStatus");
  });

  test("sourcesChanged triggers a listSources refetch that patches the snapshot", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();

    f.setSources([
      { id: "s1", kind: "folder", path: "/a", mountPath: "a", paused: false },
      { id: "s2", kind: "folder", path: "/b", mountPath: "b", paused: false },
    ]);
    f.fireEvent("sourcesChanged", { added: "/b" });
    await tick();
    expect(f.calls.filter((c) => c === "listSources")).toHaveLength(1);
    expect(store.getState().status?.sources).toHaveLength(2);
  });

  test("runFinished refetches the authoritative snapshot (counts go stale otherwise)", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    const before = f.calls.filter((c) => c === "getStatus").length;

    f.fireEvent("runFinished", { filesArchived: "2", filesTotal: "2", blobsFailed: "0" });
    await tick();
    expect(f.calls.filter((c) => c === "getStatus").length).toBe(before + 1);
  });

  test("forwards a daemon event into the store fold", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();

    f.fireEvent("fileArchived", { file: "x.jpg", blob: "b1" });
    expect(store.getState().run?.filesArchived).toBe(1);
  });

  test("reads the initial auth status and folds pushed changes", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(store.getState().auth.configured).toBe(false); // the initial pull landed

    f.fireAuth({ configured: true, state: "signedIn", email: "ben@example.com", error: null, emailAvailable: true });
    expect(store.getState().auth).toEqual({ configured: true, state: "signedIn", email: "ben@example.com", error: null, emailAvailable: true });
  });

  test("starts in 'initializing' and clears it once the first status batch lands (no startup flash)", async () => {
    const f = makeApi("connected");
    const store = createStore();
    expect(store.getState().initializing).toBe(true); // before first paint → app shows the checking gate
    connectController(f.api, store);
    await tick();
    expect(store.getState().initializing).toBe(false); // real auth/vault known → the right screen paints
  });

  test("reads the initial vault status and folds pushed changes", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(store.getState().vault.state).toBe("locked"); // the initial pull landed

    f.fireVault({ state: "unlocked", recoveryCode: null, error: null });
    expect(store.getState().vault).toEqual({ state: "unlocked", recoveryCode: null, error: null });
  });

  test("reads the initial entitlement and folds pushed changes", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(store.getState().entitlement.active).toBe(false); // initial pull landed

    f.fireEntitlement({ known: true, active: true, checkingOut: false, quotaBytes: 500_000_000_000, error: null });
    expect(store.getState().entitlement).toEqual({ known: true, active: true, checkingOut: false, quotaBytes: 500_000_000_000, error: null });
  });

  test("reads the initial update status and folds pushed changes", async () => {
    const f = makeApi("connected");
    const store = createStore();
    connectController(f.api, store);
    await tick();
    expect(store.getState().update.state).toBe("idle"); // initial pull landed

    f.fireUpdate({ state: "ready", version: "0.2.0", percent: 100, error: null });
    expect(store.getState().update).toEqual({ state: "ready", version: "0.2.0", percent: 100, error: null });
  });
});
