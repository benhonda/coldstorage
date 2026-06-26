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
  ListedFile,
  Method,
  ParamsArg,
  Pricing,
  RestoreStep,
  Source,
  Status,
  TierQuote,
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
  /** invoke: open the native folder picker; resolves to the chosen path or null. */
  chooseFolder: "dialog:chooseFolder",
  /** invoke: the OS Downloads directory (default save destination). */
  downloadsDir: "dialog:downloadsDir",
  /** invoke: present the native Photos picker; resolves to the picked asset ids (or [] if cancelled). */
  pickPhotos: "photos:pick",
} as const;

/** Whether the main process currently holds a live socket to `coldstored`. */
export type ConnectionState = "connecting" | "connected" | "disconnected";

/** One photo picked in the native picker: the PHAsset localIdentifier (drives the daemon `depositPhotos`)
 * + a suggested name for the instant optimistic row label (the daemon resolves the true filename later). */
export interface PhotoPick {
  id: string;
  name: string;
}

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
  /** Open the native folder picker (a window sheet on macOS). Resolves to the chosen absolute path, or
   * null if cancelled. `defaultPath` seeds where it opens. */
  chooseFolder(defaultPath?: string): Promise<string | null>;
  /** The OS Downloads directory (absolute) — the default save destination for a requested copy. */
  getDownloadsDir(): Promise<string>;
  /** Present the native macOS Photos picker (option B) and resolve to the picked photos ({id, name}), or []
   * if the user cancelled / picked nothing. The renderer shows optimistic rows from the names and hands the
   * ids to the daemon's `depositPhotos`. macOS-only — rejects if the picker helper is missing or fails. */
  pickPhotos(): Promise<PhotoPick[]>;
  /** Absolute path of a dropped/picked File. Electron 32+ removed `File.path`; resolved in the preload
   * via `webUtils.getPathForFile`. "" if it can't be resolved (e.g. a synthetic File). Sync — no daemon. */
  pathForFile(file: File): string;
}
