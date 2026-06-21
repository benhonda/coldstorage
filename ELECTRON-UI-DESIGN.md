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
1. **IPC bridge (main process) — DONE ✅** — `net.Socket` client for the JSONL protocol: request/response
   by id + an event emitter for pushed lines. *No design system.* Lives in [`ui/`](./ui/) — see its
   [`README.md`](./ui/README.md) for the package entry point (layout, commands, the `DaemonClient`
   usage seam). `src/daemon/{protocol,client}.ts`: typed `DaemonClient` over one long-lived id-multiplexed socket
   (bounded per-request timeout mirroring `ControlClient(readTimeout:)`; unbounded event tail;
   auto-reconnect for launchd KeepAlive restarts). `protocol.ts` is a hand-kept TS mirror of the Swift
   wire SSOT. **Proven** vs `task daemon:run`: `task ui:prove` — `getStatus` round-trips and `triggerNow`
   streams `runStarted → fileArchived → runFinished`. Dev/test on Bun; runs unchanged on Electron's Node
   (only `node:net`).
2. **Shell + typed state layer — DONE ✅** — electron-vite shell (main/preload/renderer), secure
   main↔renderer IPC (`contextIsolation` + `contextBridge` → `window.coldstore`), and the
   event-stream → app-state fold (status, sources, run progress, failures, restores). *No design
   system.* Main process owns the one `DaemonClient`; renderer is a pure consumer of `window.coldstore`.
   `src/shared/ipc.ts` is the typed seam (channels + `ColdstoreApi`); `src/renderer/src/state/`
   is `reducer` (pure fold) → `store` (`useSyncExternalStore`) → `controller` (api→store + refetch
   policy). **Proven:** `task ui:typecheck` + `task ui:build` (all 3 processes compile) +
   `task ui:test` (real reducer + controller, headless); and **verified on macOS** — the GUI runs and
   shows `connection: connected` with live status against the daemon (`task ui:dev` vs `task daemon:run`).
3. **React views** — status, sources, browse, restore. **← hand the design system over here.** Views
   exist functional-but-unstyled (`src/renderer/src/App.tsx`); skin them with the real system — no
   thrown-away CSS.

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

## Next task for the next agent
Layers 1 + 2 are done ✅ (see build order above). **Build layer 3 — the React views + design system.**
The plumbing is all there and proven: `window.coldstore` (typed `ColdstoreApi`) gives you commands +
event subscriptions; the store (`src/renderer/src/state/`) already folds the event stream into
`AppState` (status, sources, run progress, failures, restores) and React binds via
`useSyncExternalStore`. `src/renderer/src/App.tsx` is the **unstyled** view tree exercising every
command/event — skin it (and split into status/sources/restore views) with the real design system; no
plumbing rework needed. **Hold the browse view** — it's blocked on the R2 bucket (infra not scaffolded).
The GUI is **verified on macOS** — it runs and connects to the daemon (`task ui:dev` vs `task daemon:run`),
so you're building on a proven shell. **Pull current docs via the Context7 MCP** before deep React/Vite/Electron work.
