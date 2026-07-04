/**
 * Headless test of the auto-update state machine (no Electron / no electron-updater). A fake
 * {@link UpdaterPort} lets us fire the exact events electron-updater emits and assert the folded
 * {@link UpdateStatus} + the restart guard — the real logic, not a facade.
 */
import { describe, expect, test } from "bun:test";
import { UpdateManager, type UpdaterPort } from "./manager.ts";

const makePort = () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  let checks = 0;
  let quits = 0;
  const port: UpdaterPort = {
    autoDownload: false,
    on: (event, listener) => void listeners.set(event, listener),
    checkForUpdates: () => {
      checks++;
      return Promise.resolve();
    },
    quitAndInstall: () => void quits++,
  };
  return {
    port,
    emit: (event: string, payload?: unknown) => listeners.get(event)?.(payload),
    checks: () => checks,
    quits: () => quits,
  };
};

describe("UpdateManager", () => {
  test("starts idle and turns on background auto-download", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);
    expect(m.status()).toEqual({ state: "idle", version: null, percent: null, error: null });
    expect(p.port.autoDownload).toBe(true);
  });

  test("folds the happy-path event stream into ready, preserving the version throughout", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);

    p.emit("checking-for-update");
    expect(m.status().state).toBe("checking");

    p.emit("update-available", { version: "0.2.0" });
    expect(m.status()).toMatchObject({ state: "available", version: "0.2.0" });

    p.emit("download-progress", { percent: 42.7 });
    expect(m.status()).toMatchObject({ state: "downloading", version: "0.2.0", percent: 43 });

    // update-downloaded with no version in the payload keeps the one from update-available.
    p.emit("update-downloaded", {});
    expect(m.status()).toMatchObject({ state: "ready", version: "0.2.0", percent: 100 });
  });

  test("clamps download percent to 0–100", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);
    p.emit("download-progress", { percent: 150 });
    expect(m.status().percent).toBe(100);
    p.emit("download-progress", { percent: -5 });
    expect(m.status().percent).toBe(0);
  });

  test("update-not-available resets to idle", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);
    p.emit("update-available", { version: "0.2.0" });
    p.emit("update-not-available");
    expect(m.status()).toEqual({ state: "idle", version: null, percent: null, error: null });
  });

  test("error surfaces the message and stays non-fatal", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);
    p.emit("error", new Error("network down"));
    expect(m.status()).toMatchObject({ state: "error", error: "network down" });
  });

  test("notifies subscribers on change and stops after unsubscribe", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);
    const seen: string[] = [];
    const off = m.onStatus((s) => seen.push(s.state));

    p.emit("checking-for-update");
    p.emit("update-available", { version: "1.0.0" });
    expect(seen).toEqual(["checking", "available"]);

    off();
    p.emit("update-downloaded", { version: "1.0.0" });
    expect(seen).toEqual(["checking", "available"]); // no further notifications
  });

  test("restart() installs only when an update is ready", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);

    m.restart(); // idle — guarded no-op
    expect(p.quits()).toBe(0);

    p.emit("update-downloaded", { version: "1.0.0" });
    m.restart();
    expect(p.quits()).toBe(1);
  });

  test("check() asks the port for updates", () => {
    const p = makePort();
    const m = new UpdateManager(p.port);
    m.check();
    expect(p.checks()).toBe(1);
  });
});
