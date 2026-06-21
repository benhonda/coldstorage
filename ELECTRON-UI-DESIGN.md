# ColdStorage — Electron/React UI design brief

> For the next agent (who'll have the Electron skill). This is the *plan + decisions in force*, not a spec.
> The daemon (`coldstored`) is built, proven, and is the whole backend — the UI is a **thin client over its
> control socket**. Read [`ROADMAP.md`](./ROADMAP.md) first, then the control-plane section of
> [`coldstorage/README.md`](./coldstorage/README.md).

## What the UI is
A control panel for `coldstored`: see what's archived, add/remove source folders, trigger a run, watch live
progress, and restore a file. It holds **no archive logic** — the Swift daemon owns scan/encrypt/upload/
restore/journal. The UI reads state and sends commands. Brand surface is calm, plainspoken, quietly warm
(see strategy/, gitignored) — never catastrophe imagery.

## The one architectural decision (don't re-litigate)
**Electron's main process speaks the daemon's JSONL protocol directly over the unix socket** — a Node
`net.Socket` to `COLDSTORE_SOCKET`, newline-delimited JSON. **Not** by spawning `coldstorectl`, **not** via
any Swift/native bridge. The protocol is tiny and already proven; the renderer never touches the socket —
it talks to main over Electron IPC.

Why: the control protocol is *already* the client contract (`coldstorectl` and the test suite are just
other clients of it). A Node client is ~30 lines and keeps the UI a pure consumer.

## The contract (SSOT — do not duplicate, bind to these)
- **Wire shape:** `Sources/ColdStorageCore/ControlProtocol.swift` — one `ControlRequest` per line
  (`{id, method, params?}`); replies carry `id` (`{id, result|error}`); pushed events carry `event`
  (`{event, data}`). The client distinguishes by which key is present.
- **Commands (SSOT = `DaemonService.handle`):** `ping · getStatus · listSources · addSource · removeSource ·
  triggerNow · restore · pause · resume`.
- **Events (SSOT = `DaemonEvent(...)` call sites):** `runStarted · fileArchived · runFinished · blobFailed ·
  sourcesChanged · restoreRequested · restoreInProgress · restoreCompleted · paused · resumed · error`.
- **Connection model:** keep one **long-lived** socket connection for the live event stream (blocks
  indefinitely by design — that's the "watch" mode). Use bounded request/response for commands. Mirror the
  `ControlClient(path:readTimeout:)` semantics: a `readTimeout` for request/response so a stalled daemon
  fails fast; none for the event tail. Match request replies by `id`; events interleave.

## Build order — and where your design system lands
1. **IPC bridge (main process)** — `net.Socket` client for the JSONL protocol: request/response by id +
   an event emitter for pushed lines. *No design system.* Verifiable against a running `task daemon:run`.
2. **Shell + typed state layer** — Electron window, main↔renderer IPC, a typed client mirroring the
   protocol, event-stream → app state (status, sources, run progress, failures). *No design system.*
3. **React views** — status, sources, browse, restore. **← hand the design system over here.** Build
   layers 1–2 functional-but-unstyled so views get skinned with the real system, not thrown-away CSS.

## Dependencies & gotchas (save the next agent hours)
- **R2 browse index is blocked on infra.** The "browse your archive" view needs R2 thumbnails + a browse
  index, which need an **R2 bucket that isn't scaffolded yet** (`infra/coldstorage` — roadmap item, not
  done). Layers 1–2 and the status/sources/restore views work against the daemon **today** with no infra;
  slot the browse view in once the bucket exists. Don't block the whole UI on R2.
- **Socket perms:** the socket is `0600` (owner-only). Electron runs as the same user as the LaunchAgent —
  fine. Default path: `COLDSTORE_SOCKET` (dev: `coldstorage/coldstored.sock`; installed:
  `~/Library/Application Support/ColdStorage/coldstored.sock`).
- **Restore is idempotent/one-step.** `restore` returns `state` ∈ `restored | thawRequested | thawInProgress`
  (+ `typicalWait` while thawing). The UI drives it like the CLI: call, show the quoted wait, re-issue /
  reflect `restore*` events until `restored`. Don't expect one call to block for hours.
- **JS tooling is Bun** per repo convention (CLAUDE.md), but Electron's main runs on its bundled Node — the
  Electron skill will reconcile this. Add deps with `bun add <pkg>@latest`.
- **There's a `status.json`** the daemon writes (`COLDSTORE_STATUS`) as a first-paint seed, but the socket
  is the live source — prefer it.

## First task for the next agent
Build layer 1 (the Node IPC bridge) and prove it against `task daemon:run`: `getStatus` round-trips and a
`triggerNow` produces `runStarted`/`fileArchived`/`runFinished` on the event stream. Everything else builds
on that.
