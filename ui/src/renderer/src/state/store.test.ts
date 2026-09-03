import { describe, expect, test } from "bun:test";
import { createStore } from "./store.ts";
import { eventAction } from "./reducer.ts";

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("store — coalesced dispatch", () => {
  test("a burst of events folds in one notify, in arrival order", async () => {
    const store = createStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.dispatchCoalesced(eventAction("runStarted", { depositId: "" }));
    for (let i = 0; i < 100; i++) store.dispatchCoalesced(eventAction("fileArchived", { file: `f${i}`, blob: `b${i}` }));
    expect(notified).toBe(0); // nothing yet — the frame hasn't elapsed
    await frame();
    expect(notified).toBe(1);
    expect(store.getState().run?.filesArchived).toBe(100);
  });

  test("a direct dispatch drains the queue first, so folds keep arrival order", () => {
    const store = createStore();
    store.dispatchCoalesced(eventAction("runStarted", { depositId: "" }));
    store.dispatchCoalesced(eventAction("fileArchived", { file: "a", blob: "b" }));
    store.dispatch({ type: "connection", state: "connected" });
    expect(store.getState().run?.filesArchived).toBe(1);
    expect(store.getState().connection).toBe("connected");
  });
});
