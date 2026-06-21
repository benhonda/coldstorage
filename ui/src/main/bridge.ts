/**
 * The main-process bridge: the only place the renderer's IPC contract meets the layer-1 client.
 * Owns no state beyond the current {@link ConnectionState}; everything else lives in the daemon.
 *
 *   - commands   `ipcMain.handle(IPC.request)` → `client.request(...)` (reply or reject travels back
 *                over the same invoke; daemon errors surface as a rejected promise in the renderer).
 *   - events     `client.onAnyEvent` → broadcast `IPC.event` to every window.
 *   - lifecycle  `client.on('connect'|'disconnect')` → track + broadcast `IPC.lifecycle`.
 *
 * Broadcasts target all windows (the daemon broadcasts events to every socket connection; we mirror
 * that to every webContents) and skip destroyed ones.
 */
import { BrowserWindow, ipcMain } from "electron";
import type { DaemonClient } from "../daemon/client.ts";
import { IPC, type ConnectionState } from "../shared/ipc.ts";

/** Wire a client to IPC. Returns a disposer that tears down all handlers/subscriptions. */
export const registerBridge = (client: DaemonClient): (() => void) => {
  let state: ConnectionState = client.isConnected ? "connected" : "connecting";

  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, ...args);
    }
  };

  // Commands. The (method, params) pair is correlated only at runtime — narrow to a loose callable at
  // this single boundary rather than scatter casts. A rejected promise propagates to the renderer.
  const call = client.request.bind(client) as (
    method: string,
    params?: Record<string, string>,
  ) => Promise<unknown>;
  ipcMain.handle(IPC.request, (_e, method: string, params?: Record<string, string>) =>
    call(method, params),
  );
  ipcMain.handle(IPC.connectionState, () => state);

  // Pushes.
  const offEvent = client.onAnyEvent((name, data) => broadcast(IPC.event, name, data));
  const setState = (next: ConnectionState): void => {
    state = next;
    broadcast(IPC.lifecycle, state);
  };
  const offConnect = client.on("connect", () => setState("connected"));
  const offDisconnect = client.on("disconnect", () => setState("disconnected"));

  return () => {
    ipcMain.removeHandler(IPC.request);
    ipcMain.removeHandler(IPC.connectionState);
    offEvent();
    offConnect();
    offDisconnect();
  };
};
