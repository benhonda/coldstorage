# ColdStorage UI

The control panel for `coldstored` — a **thin client over the daemon's control socket**. Holds no
archive logic: the Swift daemon owns scan/encrypt/upload/restore/journal; this reads state and sends
commands. Full plan + decisions: [`../ELECTRON-UI-DESIGN.md`](../ELECTRON-UI-DESIGN.md). Orientation:
[`../ROADMAP.md`](../ROADMAP.md).

## Status

| Layer | What | State |
|-------|------|-------|
| 1 | Node IPC bridge (`node:net` → JSONL control socket) | **DONE ✅** |
| 2 | Electron shell + main↔renderer IPC + event-stream→typed state | next |
| 3 | React views (status/sources/browse/restore) — design system enters here | after |

## Layout

```
src/daemon/
  protocol.ts   TS mirror of the Swift wire SSOT — envelopes, command results, event shapes.
                NOT a source of truth: tracks ControlProtocol.swift + DaemonService DTOs +
                DaemonEvent(...) call sites. Keep in lockstep when the daemon's contract changes.
  client.ts     DaemonClient — the layer-1 bridge. One long-lived id-multiplexed socket:
                bounded per-request timeout (mirrors ControlClient(readTimeout:)), unbounded
                event tail, auto-reconnect (launchd KeepAlive restarts the daemon).
  prove.ts      Layer-1 proof harness (real checks, run by `task ui:prove`).
```

## Commands (run from repo root)

```sh
task ui:setup       # bun install (once)
task ui:typecheck   # strict tsc

# prove the bridge against a live daemon:
task daemon:run &   # wait for coldstorage/coldstored.sock to appear
task ui:prove       # getStatus round-trips + triggerNow streams runStarted→fileArchived→runFinished
```

## The contract seam (for layer 2)

`DaemonClient` is the typed boundary — the **Electron main process owns one instance**, the renderer
talks to main over Electron IPC and never touches the socket. Use it like:

```ts
import { DaemonClient } from "./daemon/client.ts";

const client = new DaemonClient();           // defaults to $COLDSTORE_SOCKET or the dev path
await client.connect();
const status = await client.request("getStatus");          // typed → Status
await client.request("addSource", { path: "/abs/dir" });   // typed params
client.onEvent("fileArchived", ({ file, blob }) => { /* … */ });
client.on("disconnect", () => { /* show "reconnecting…" */ });
```

## Gotchas

- **Pull current docs via the Context7 MCP.** Before wiring Electron/React/Vite (layers 2–3), reference
  up-to-date docs through Context7 — it's 2026, these APIs move; don't build from memory.
- **Tooling is Bun, runtime is Electron's Node.** Layer 1 uses only `node:net`, so it runs unchanged
  under both. Layer 2 introduces Electron — reconcile Bun-for-dev vs Electron's bundled Node there.
- **Socket path:** `$COLDSTORE_SOCKET`, else `coldstorage/coldstored.sock` (dev). Installed path is
  `~/Library/Application Support/ColdStorage/coldstored.sock`. Socket is `0600` (owner-only).
- **Restore is idempotent/one-step** — `restore` returns `state ∈ restored|thawRequested|thawInProgress`;
  re-issue / reflect `restore*` events until `restored`. Don't expect one call to block for hours.
- **Browse view is blocked on infra** (R2 bucket not scaffolded). Build status/sources/restore first.
