/**
 * DaemonClient dial/retry — reproduces the packaged-app startup race that shipped as the
 * "Setting up…" hang (root-caused 2026-07-10): the app dials at `ready` while its just-spawned
 * daemon child is still binding the socket. A lost FIRST dial must enter the reconnect cycle and
 * converge once the socket appears — it used to arm the retry only after a successful connection,
 * leaving the loser disconnected forever.
 *
 * Sockets are injected via the `dial` seam (fake EventEmitter sockets), not real ones: bun test
 * v1.3 flags a real socket's `error` event as a test failure even when it's handled and the
 * promise is caught (verified against `bun run`, where the same pattern is clean).
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type net from "node:net";
import { DaemonClient } from "./client.ts";

/** A dialable world: `serverUp` decides whether the next dial connects or errors (async, like net). */
const fakeWorld = () => {
  const world = { serverUp: false, dials: 0 };
  const dial = (): net.Socket => {
    world.dials++;
    const socket = new EventEmitter() as unknown as net.Socket & EventEmitter;
    Object.assign(socket, {
      setNoDelay: () => socket,
      write: () => true,
      destroy: () => queueMicrotask(() => socket.emit("close")),
    });
    queueMicrotask(() => {
      if (world.serverUp) socket.emit("connect");
      else socket.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    });
    return socket;
  };
  return { world, dial };
};

describe("DaemonClient first-dial race", () => {
  test("a dial that loses the race to the daemon's bind retries and converges", async () => {
    const { world, dial } = fakeWorld();
    const client = new DaemonClient({ socketPath: "/fake.sock", reconnectDelayMs: 5, dial });
    const connected = new Promise<void>((resolve) => client.on("connect", () => resolve()));

    // Daemon not up yet — the first dial fails (the rejection itself is non-fatal by contract)…
    await client.connect().then(
      () => {
        throw new Error("first dial unexpectedly succeeded");
      },
      () => {},
    );
    expect(client.isConnected).toBe(false);

    // …then the daemon binds its socket a beat later, and the retry loop must find it.
    world.serverUp = true;
    await connected; // hung forever here before the fix
    expect(client.isConnected).toBe(true);
    client.close();
  });

  test("close() during the retry loop stops redialing for good", async () => {
    const { world, dial } = fakeWorld();
    const client = new DaemonClient({ socketPath: "/fake.sock", reconnectDelayMs: 5, dial });
    await client.connect().catch(() => {});
    const dialsAtClose = world.dials;
    client.close();

    // The daemon comes up AFTER close — a live retry loop would now dial + connect; closed must not.
    world.serverUp = true;
    await new Promise((r) => setTimeout(r, 30)); // several reconnectDelayMs windows
    expect(world.dials).toBe(dialsAtClose);
    expect(client.isConnected).toBe(false);
  });
});
