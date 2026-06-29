/**
 * Headless test of the controller's sync policy (no Electron). A fake {@link ColdstoreApi} stands in
 * for `window.coldstore` so we can fire lifecycle/events and assert the real controller drives the
 * real store correctly: initial fetch, refetch-on-(re)connect, and sourcesChanged → listSources.
 */
import { describe, expect, test } from "bun:test";
import type { ColdstoreApi, ConnectionState, ListedFile, Source, Status } from "../../../shared/ipc.ts";
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
});
