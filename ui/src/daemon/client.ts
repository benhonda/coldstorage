/**
 * Layer 1 — the IPC bridge. A Node `net.Socket` client for the `coldstored` control plane, speaking
 * its newline-delimited JSON directly (NOT by spawning `coldstorectl`, NOT via a native bridge — see
 * ui/DESIGN.md). This is the whole backend contract for the UI; the renderer never touches
 * the socket, it talks to this over Electron IPC (layer 2).
 *
 * One long-lived connection carries both replies and pushed events (the daemon broadcasts events to
 * every connection — so a single fd is enough; we id-multiplex requests over it and surface events on
 * the side). This mirrors `ControlClient` semantics: bounded request/response (a per-request timeout,
 * so a stalled daemon fails fast) and an unbounded event tail (no timeout — it blocks by design).
 *
 * Survives daemon restarts (launchd KeepAlive): on disconnect, pending requests reject and — if
 * `autoReconnect` — we redial with a fixed backoff, re-emitting `connect` so a watcher can resync.
 */
import net from "node:net";
import { EventEmitter } from "node:events";
import {
  type Commands,
  type ControlLine,
  type DaemonEventName,
  type DaemonEvents,
  type Method,
  type ParamsArg,
  isEventLine,
  isResponseLine,
} from "./protocol.ts";

/** Resolve the default socket path: `$COLDSTORE_SOCKET`, else the dev path used by `task daemon:run`. */
export const defaultSocketPath = (): string =>
  process.env.COLDSTORE_SOCKET ?? "coldstorage/coldstored.sock";

export interface DaemonClientOptions {
  /** Unix socket path. Defaults to {@link defaultSocketPath}. */
  socketPath?: string;
  /** Per-request timeout (ms) — mirrors `ControlClient(readTimeout:)`. Default 10_000. */
  requestTimeoutMs?: number;
  /** Redial on disconnect (default true). The event tail itself is never timed out. */
  autoReconnect?: boolean;
  /** Backoff between redials (ms). Default 1_000. */
  reconnectDelayMs?: number;
  /** Socket factory — the test seam for the dial/retry logic (bun test v1.3 can't host real
   * failing sockets: it flags the socket's `error` event even when handled). Defaults to
   * `net.createConnection`. */
  dial?: (socketPath: string) => net.Socket;
}

/** Lifecycle events emitted alongside daemon events (distinct namespaces, never collide). */
interface LifecycleEvents {
  connect: () => void;
  disconnect: (err?: Error) => void;
  /** Catch-all for every daemon-pushed event, tagged with its name. */
  event: <E extends DaemonEventName>(name: E, data: DaemonEvents[E]) => void;
}

type PendingResolver = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class DaemonClient {
  private readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly dial: (socketPath: string) => net.Socket;

  private socket: net.Socket | null = null;
  private connected = false;
  private closing = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private buf = Buffer.alloc(0);
  private readonly emitter = new EventEmitter();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DaemonClientOptions = {}) {
    this.socketPath = opts.socketPath ?? defaultSocketPath();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1_000;
    this.dial = opts.dial ?? net.createConnection;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Dial the socket. Resolves once connected; rejects if the first dial fails — but a failed dial
   * still enters the reconnect cycle (autoReconnect), so a caller may treat the rejection as
   * non-fatal and wait for the eventual `connect` lifecycle push. This matters most for the
   * packaged app: it dials at `ready` while its just-spawned `coldstored` child is still binding
   * the socket, and whoever loses that race must not stay disconnected forever (the "Setting up…"
   * hang, root-caused 2026-07-10 — the retry used to arm only AFTER a successful connection). */
  connect(): Promise<void> {
    this.closing = false;
    return new Promise((resolve, reject) => {
      const socket = this.dial(this.socketPath);
      this.socket = socket;
      socket.setNoDelay(true);

      const onError = (err: Error) => {
        socket.removeListener("connect", onConnect);
        // A failed FIRST dial never reaches onClose (its close handler is attached on connect),
        // so it must arm the retry loop itself — same policy as a post-connect drop.
        if (this.autoReconnect && !this.closing) this.scheduleReconnect();
        reject(err);
      };
      const onConnect = () => {
        socket.removeListener("error", onError);
        this.connected = true;
        socket.on("data", (chunk: Buffer | string) =>
          this.onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
        );
        socket.on("close", () => this.onClose());
        socket.on("error", () => {}); // post-connect errors surface via 'close'
        this.emitLifecycle("connect");
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  /** Close for good — no reconnect, pending requests rejected. */
  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  /**
   * Send a command and await its reply (matched by id). Rejects on daemon `error`, on timeout, or if
   * the connection drops while in flight. Typed end-to-end via {@link Commands}.
   */
  request<M extends Method>(method: M, ...args: ParamsArg<M>): Promise<Commands[M]["result"]> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error(`not connected to ${this.socketPath}`));
        return;
      }
      const id = this.nextId++;
      // No cast: `ParamsArg` now guarantees every value is a string (see `StringParams` in protocol.ts).
      // The cast that used to live here is what let a boolean param compile and break the wire.
      const params: Record<string, string | undefined> | undefined = args[0];
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${method}' (id ${id}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        timer,
      });
      const line = JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n";
      this.socket.write(line);
    });
  }

  /** Subscribe to one daemon event by name. Returns an unsubscribe fn. */
  onEvent<E extends DaemonEventName>(name: E, listener: (data: DaemonEvents[E]) => void): () => void {
    const wrapped = (n: DaemonEventName, data: unknown) => {
      if (n === name) listener(data as DaemonEvents[E]);
    };
    this.emitter.on("event", wrapped);
    return () => this.emitter.off("event", wrapped);
  }

  /** Subscribe to every daemon event (tagged with its name). Returns an unsubscribe fn. */
  onAnyEvent(listener: LifecycleEvents["event"]): () => void {
    this.emitter.on("event", listener as (...a: unknown[]) => void);
    return () => this.emitter.off("event", listener as (...a: unknown[]) => void);
  }

  /** Subscribe to a lifecycle event (`connect` / `disconnect`). Returns an unsubscribe fn. */
  on<K extends "connect" | "disconnect">(name: K, listener: LifecycleEvents[K]): () => void {
    this.emitter.on(name, listener as (...a: unknown[]) => void);
    return () => this.emitter.off(name, listener as (...a: unknown[]) => void);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Frame inbound bytes into newline-delimited JSON lines and dispatch each. */
  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) !== -1) {
      const line = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      if (line.length === 0) continue;
      let parsed: ControlLine;
      try {
        parsed = JSON.parse(line.toString("utf8")) as ControlLine;
      } catch {
        continue; // skip a malformed line rather than tear down the stream
      }
      this.dispatch(parsed);
    }
  }

  private dispatch(line: ControlLine): void {
    if (isResponseLine(line)) {
      const p = this.pending.get(line.id);
      if (!p) return; // late/duplicate reply — ignore
      this.pending.delete(line.id);
      clearTimeout(p.timer);
      if (line.error !== undefined) p.reject(new Error(line.error));
      else p.resolve(line.result);
      return;
    }
    if (isEventLine(line)) {
      this.emitter.emit("event", line.event as DaemonEventName, line.data);
    }
  }

  private onClose(): void {
    this.connected = false;
    this.socket = null;
    const err = new Error("control connection closed");
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emitLifecycle("disconnect", err);
    if (this.autoReconnect && !this.closing) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing) return;
      this.connect().catch(() => this.scheduleReconnect()); // keep retrying until the daemon is back
    }, this.reconnectDelayMs);
  }

  private emitLifecycle(name: "connect"): void;
  private emitLifecycle(name: "disconnect", err: Error): void;
  private emitLifecycle(name: "connect" | "disconnect", err?: Error): void {
    this.emitter.emit(name, err);
  }
}
