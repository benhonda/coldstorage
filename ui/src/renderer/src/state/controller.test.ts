/**
 * Headless test of the controller's sync policy (no Electron). A fake {@link ColdstoreApi} stands in
 * for `window.coldstore` so we can fire lifecycle/events and assert the real controller drives the
 * real store correctly: initial fetch, refetch-on-(re)connect, and sourcesChanged → listSources.
 */
import { describe, expect, test } from "bun:test";
import type { ColdstoreApi, ConnectionState, Source, Status } from "../../../shared/ipc.ts";
import { connectController } from "./controller.ts";
import { createStore } from "./store.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const status = (sources: Source[]): Status => ({
  filesTotal: 1,
  filesArchived: 1,
  blobsVerified: 1,
  paused: false,
  running: false,
  permanentlyFailedBlobs: 0,
  sources,
});

/** A controllable fake of the preload surface. */
const makeApi = (initial: ConnectionState) => {
  let connectionState = initial;
  let sources: Source[] = [{ id: "s1", kind: "folder", path: "/a" }];
  const calls: string[] = [];
  let eventCb: ((name: never, data: never) => void) | null = null;
  let lifeCb: ((s: ConnectionState) => void) | null = null;

  const api: ColdstoreApi = {
    request: ((method: string) => {
      calls.push(method);
      if (method === "getStatus") return Promise.resolve(status(sources));
      if (method === "listSources") return Promise.resolve(sources);
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
  };

  return {
    api,
    calls,
    setSources: (s: Source[]) => (sources = s),
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
      { id: "s1", kind: "folder", path: "/a" },
      { id: "s2", kind: "folder", path: "/b" },
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
