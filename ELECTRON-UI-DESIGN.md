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
3. **React views + design system — DONE ✅** — skinned with the **coldstorage Design System** (Claude
   Design project `41ebafc1`). The DS ships as a UMD/Babel-CDN bundle (its native runtime), so it was
   **ported to native React 19 TSX** bound to the DS token vars — NOT consumed as the bundle. Layout:
   `src/renderer/src/styles/tokens/` (the 5 token CSS files **vendored verbatim** from the DS — the
   SSOT, re-sync if it changes) + `styles/app.css` (component/shell styling, all `var(--*)`);
   `src/renderer/src/ui/` (`primitives.tsx` = Button/Card/Stat/Badge/KeyValueRow/Field/EmptyState/Icon;
   `layout.tsx` = Sidebar + Page); `src/renderer/src/views/` (Vault = proof-of-safety wall, Sources,
   Restore). `App.tsx` is now a thin shell (sidebar routing + a shared `exec` + an error toast). **Fonts
   self-hosted** (`@fontsource/hanken-grotesk`, `@fontsource/jetbrains-mono`, `material-symbols`) so they
   bundle same-origin under the renderer's locked-down CSP (`default-src 'self'`) — the DS's Google-Fonts
   `@import` would have been blocked. **Proven:** `task ui:typecheck` + `task ui:build` green.
   **PENDING Ben (macOS):** visual verify via `task ui:demo` (or `task ui:dev` vs `task daemon:run`) —
   can't render Electron here. **Browse is held** (R2-blocked) — shown as a disabled nav item.
   *Later optimization:* subset the 5.3 MB Material Symbols woff2 to the ~12 glyphs used.

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
Layers 1 + 2 + 3 are done ✅ (see build order above). The control panel is fully skinned in the
coldstorage Design System (ported to native TSX). **Remaining UI work, in order:**
1. **macOS visual verify** (Ben) — `task ui:demo` (MinIO + daemon + UI) or `task ui:dev` vs
   `task daemon:run`. Build + typecheck are green here, but Electron can't render in the container, so
   the *look* is unverified. Expect small spacing/polish tweaks against the DS specimens.
2. **Browse view** — held, blocked on the **R2 bucket** (infra not scaffolded). It's a disabled nav
   item today; build it (thumbnails + browse index) once the bucket exists.
3. **Native folder picker** for Add-source (main-process `dialog.showOpenDialog`) — today the path is
   typed. Small, high-value polish.
4. **Subset Material Symbols** — the bundled rounded woff2 is 5.3 MB (full set); subset to the glyphs
   actually used (`ac_unit folder cloud_download cloud_upload cloud_done cloud_data description verified
   pause play_arrow add close error sync check create_new_folder photo_library pause_circle`).

When extending: components live in `src/renderer/src/ui/` (bound to the vendored token vars in
`styles/tokens/` — the DS SSOT, re-sync don't hand-edit). **Pull current docs via the Context7 MCP**
before deep React/Vite/Electron work.
