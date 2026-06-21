/**
 * The main↔renderer IPC contract (layer 2). SSOT for the seam between Electron's main process — which
 * owns the one {@link DaemonClient} and the unix socket — and the renderer, which never touches the
 * socket and only sees the narrow {@link ColdstoreApi} the preload exposes on `window.coldstore`.
 *
 * Two directions:
 *   - commands  renderer → main → daemon : one invoke channel ({@link IPC.request}), id-multiplexed
 *               request/response handled by the layer-1 client. Typed end-to-end via {@link Commands}.
 *   - pushes    main → renderer          : daemon events ({@link IPC.event}) and connection lifecycle
 *               ({@link IPC.lifecycle}), broadcast to every window's webContents.
 *
 * Daemon wire types are re-exported here so the renderer binds to ONE seam (never reaches into
 * `daemon/`, which is main-process-only). They're type-only — `protocol.ts` has zero runtime/Node deps.
 */
export type {
  Ack,
  Commands,
  DaemonEventName,
  DaemonEvents,
  Method,
  ParamsArg,
  RestoreStep,
  Source,
  Status,
} from "../daemon/protocol.ts";

import type { Commands, DaemonEventName, DaemonEvents, Method, ParamsArg } from "../daemon/protocol.ts";

/** Channel names. Namespaced so they never collide with other IPC a window might use. */
export const IPC = {
  /** invoke: send a command, await its reply (or rejection). */
  request: "daemon:request",
  /** invoke: read the current connection state (so a fresh window initializes without waiting). */
  connectionState: "daemon:connectionState",
  /** push: one daemon event, `(name, data)`. */
  event: "daemon:event",
  /** push: connection lifecycle changed, `(state)`. */
  lifecycle: "daemon:lifecycle",
} as const;

/** Whether the main process currently holds a live socket to `coldstored`. */
export type ConnectionState = "connecting" | "connected" | "disconnected";

/**
 * The surface the preload exposes on `window.coldstore` via `contextBridge`. The renderer's entire
 * view of the backend — typed against the daemon contract, with no access to Node, the socket, or
 * `ipcRenderer`. Subscriptions return an unsubscribe fn (call it on unmount).
 */
export interface ColdstoreApi {
  /** Send a command to the daemon and await its typed reply. Rejects on daemon error / timeout / drop. */
  request<M extends Method>(method: M, ...params: ParamsArg<M>): Promise<Commands[M]["result"]>;
  /** Current connection state — for first paint before any lifecycle push arrives. */
  getConnectionState(): Promise<ConnectionState>;
  /** Subscribe to every daemon-pushed event (tagged with its name). */
  onEvent(listener: <E extends DaemonEventName>(name: E, data: DaemonEvents[E]) => void): () => void;
  /** Subscribe to connection-state changes. */
  onLifecycle(listener: (state: ConnectionState) => void): () => void;
}
