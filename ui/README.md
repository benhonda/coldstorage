# ColdStorage UI

The control panel for `coldstored` — a **thin client over the daemon's control socket**. Holds no
archive logic: the Swift daemon owns scan/encrypt/upload/restore/journal; this reads state and sends
commands. Full plan + decisions: [`../ELECTRON-UI-DESIGN.md`](../ELECTRON-UI-DESIGN.md). Orientation:
[`../ROADMAP.md`](../ROADMAP.md).

## Status

| Layer | What | State |
|-------|------|-------|
| 1 | Node IPC bridge (`node:net` → JSONL control socket) | **DONE ✅** |
| 2 | electron-vite shell + main↔renderer IPC + event-stream→typed state | **DONE ✅** |
| 3 | Design system (tokens + primitives) + React views | **DONE ✅ — My Files + Settings, browser on real `listFiles` (visual-verify pending)** |

> ✅ **The reorganizable-filesystem redesign is BUILT (2026-06-24)** — two surfaces, **My Files** (drill-in
> file browser: drop-to-upload, status icons, row ⋯ dropdown + Get-info modal, reorganize, request-a-copy
> modal w/ native folder picker) + **Settings** (watched folders, exclude chips, storage). The old 4-tab
> Vault/Sources/Restore/Browse views are deleted; DS tokens/primitives/fonts + all layer-1/2 plumbing
> were kept. `task ui:typecheck` + `task ui:test` + `task ui:build` green. **PENDING Ben (macOS): visual
> verify** (`task ui:demo` / `ui:live` — Electron can't render in the container). The browser tree is
> **real journal data** — the daemon's `listFiles` read is built and the fixtures stand-in is deleted
> (proven vs MinIO, `task ui:prove`); **drop-to-upload / "Choose files" really archive through the daemon**
> (the `deposit` command, proven vs MinIO); request-a-copy issues the **real `restore` command**.
> move/rename/delete remain optimistic-local seams (honest — they're cheap journal edits in the real
> design, reverted to the `listFiles` truth on the next read until those daemon commands land).
>
> **Error states (UI side, 2026-06-24):** a failed upload shows ⚠ **couldn't upload** on the row (kept
> visible), a **light-red error toast**, a persistent sidebar **"N couldn't upload"** → `FailuresPanel`
> (permanent failures only — transient stays "uploading" and self-heals), and **Retry upload** in the row
> ⋯ menu (re-issues `deposit` from the row's `srcPath`). A permanent failure is journal truth (the daemon
> marks the file `failed` → `listFiles` returns it → the ⚠ survives a refresh/restart), and the panel
> **names** the failed files (via `blobFailed.paths`). Uploading rows show a **determinate** % bar for large
> solo-blob files (the daemon's `uploadProgress` event), falling back to an indeterminate stripe for small
> batched files.

Toolchain: **electron-vite** (Vite, three-process split), **React 19**, secure IPC
(`contextIsolation: true`, `contextBridge`). Tooling runs on **Bun**; the Electron runtime is its own
bundled Node. The DS port (tokens + primitives) is verified live on macOS (`task ui:live`); see
[Design system](#design-system).

## Layout

```
electron.vite.config.ts   three-process build (entries auto-discovered from src/{main,preload,renderer})
tsconfig.{base,node,web}.json   split: node project (main/preload/daemon/shared) + web project (renderer)

src/daemon/         LAYER 1 — main-process only; the renderer never imports this.
  protocol.ts   TS mirror of the Swift wire SSOT — envelopes, command results, event shapes.
                NOT a source of truth: tracks ControlProtocol.swift + DaemonService DTOs +
                DaemonEvent(...) call sites. Keep in lockstep when the daemon's contract changes.
  client.ts     DaemonClient — one long-lived id-multiplexed socket: bounded per-request timeout
                (mirrors ControlClient(readTimeout:)), unbounded event tail, auto-reconnect.
  prove.ts      Layer-1 proof harness (real checks vs a live daemon, run by `task ui:prove`).

src/shared/
  ipc.ts        SSOT for the main↔renderer seam: channel names + the typed `ColdstoreApi` surface.
                Re-exports daemon wire TYPES so the renderer binds to one seam, never to daemon/.

src/main/         Electron main process — owns the one DaemonClient + the window.
  index.ts      app/window lifecycle; dials the daemon (autoReconnect); secure webPreferences.
  bridge.ts     DaemonClient ⇄ IPC: ipcMain.handle(commands) + webContents push(events/lifecycle).
  system.ts     OS integrations the renderer can't reach: native folder picker + Downloads dir
                (dialog.showOpenDialog), used by the request-a-copy dialog. Not daemon-related.

src/preload/
  index.ts      contextBridge.exposeInMainWorld("coldstore", api) — the ONLY thing the renderer sees.
                Also exposes `pathForFile` (webUtils.getPathForFile) so the renderer resolves dropped/picked
                File objects → absolute paths for `deposit` (Electron 32+ removed File.path).

src/renderer/     The web app (React). No Node, no socket — talks to window.coldstore.
  index.html, src/main.tsx (font + style imports), src/useStore.ts, src/env.d.ts
  src/App.tsx     LAYER 3 — thin 2-route shell: routes My Files / Settings; owns the cross-view state
                  (useFiles + useSettings); shared `exec` runner + error toast + sidebar foot reassurance.
  src/state/
    reducer.ts      pure event-stream → AppState fold (+ eventAction constructor). Headless-testable.
    store.ts        tiny observable store (useSyncExternalStore-shaped).
    controller.ts   side-effecting glue: api events/lifecycle → store; refetch policy.
    *.test.ts       headless tests (bun test) — real reducer + real controller, fake api.
  src/styles/     LAYER 3 — tokens/ = the 5 DS token CSS files VENDORED verbatim (the SSOT, re-sync
                  don't hand-edit); app.css = component/shell styling (all var(--*)); index.css = entry.
  src/ui/         LAYER 3 — DS primitives ported to native TSX: primitives.tsx (Button, IconButton, Card,
                  Stat, Badge, KeyValueRow, Field, EmptyState, Alert, Chip, Modal, Icon) + layout.tsx
                  (Sidebar w/ foot slot, Page w/ ReactNode title + `fill` mode).
  src/views/      LAYER 3 — MyFilesView (browser) + SettingsView + types.ts (ViewProps/Exec).
    files/        the browser's domain layer:
      model.ts        PURE, headless-tested: ArchivedFile/Row tree, rollups, path-rewrite ops, formatters,
                      and fileFromJournal (raw daemon ListedFile → browser ArchivedFile; status coarsening).
      model.test.ts   bun-test coverage of the tree derivation + reorganize math + fileFromJournal mapping.
      useFiles.ts     file state seeded from the daemon's listFiles (App maps state.files → ArchivedFile[]);
                      deposit() adds optimistic "uploading" rows carrying srcPath (for retry) + setDepositStatus()
                      flips them uploading⇄failed; move/rename/delete/newFolder are optimistic-local seams;
                      overlays live restore status from the store. useSettings.ts = exclude chips.
      Breadcrumb, StatusBadge (StatusIcon: ✓ stored · ↑ uploading · ⚠ couldn't upload · ↓ transferring ·
                      saved-here), ContextMenu (incl. Retry upload on failed rows), InfoModal (Get info),
                      RequestBackModal (request-a-copy + native folder picker), GettingBackPanel (transfer
                      queue), FailuresPanel (the sidebar "N couldn't upload" popover + Try again).
```

## Commands (run from repo root)

```sh
task ui:setup       # bun install (once)
task ui:typecheck   # strict tsc (node + web projects)
task ui:test        # headless state-layer tests (no Electron/daemon needed)
task ui:build       # build main/preload/renderer → ui/out

# dogfood locally — ONE command: MinIO + daemon (bg) + UI (installs minio/mc if missing):
task ui:demo        # then archive files + restore from the UI; `task dev:stop` to tear down

# or run the pieces yourself (macOS; HMR):
task daemon:run &   # wait for coldstorage/coldstored.sock
task ui:dev

# dogfood against the INSTALLED launchd daemon — real prod AWS (needs task daemon:bootstrap done):
task ui:live        # same UI, COLDSTORE_SOCKET → ~/Library/Application Support/ColdStorage/coldstored.sock

# prove the layer-1 bridge against a live daemon:
task ui:prove       # getStatus round-trips + triggerNow streams runStarted→fileArchived→runFinished
```

## The IPC contract seam

`DaemonClient` (layer 1) is the typed socket boundary — the **main process owns one instance**. The
renderer never touches it; it talks to main over Electron IPC via the narrow `window.coldstore`
surface (`ColdstoreApi` in `src/shared/ipc.ts`), which mirrors the same typed commands/events:

```ts
// renderer — window.coldstore (exposed by the preload)
const status = await window.coldstore.request("getStatus");          // typed → Status
await window.coldstore.request("addSource", { path: "/abs/dir" });   // typed params
const off = window.coldstore.onEvent((name, data) => { /* typed by name */ });
window.coldstore.onLifecycle((state) => { /* "connecting"|"connected"|"disconnected" */ });
```

State flows one way: daemon events → `controller` → `reducer` → `store` → React (`useSyncExternalStore`).

## Design system

Layer 3 is skinned in the **coldstorage Design System** — Claude Design project `41ebafc1` (light-only,
iceberg-blue, Hanken Grotesk + JetBrains Mono; calm/honest/sentence-case voice, no exclamation marks,
no emoji). The DS ships as a UMD/Babel-CDN component bundle (its native runtime); that **doesn't compose
with electron-vite**, so it was **ported to native React 19 TSX** bound to the DS token vars — we consume
the *tokens*, not the bundle.

- **Tokens are the SSOT.** `src/styles/tokens/{colors,typography,spacing,effects,base}.css` are vendored
  *verbatim* from the DS (provenance-stamped). Re-sync from the DS if it changes; don't hand-edit. All
  component CSS in `app.css` references `var(--*)` — never hand-pick a color/size.
- **Fonts are self-hosted** (`@fontsource/hanken-grotesk`, `@fontsource/jetbrains-mono`, `material-symbols`,
  imported in `main.tsx`) so they bundle as same-origin assets under the renderer's locked-down CSP
  (`default-src 'self'`). The DS's Google-Fonts `@import` would be blocked; non-variable Fontsource
  packages keep the family names matching the tokens.
- **To iterate the design:** pull the DS via the `claude_design` MCP (`get_claude_design_prompt`,
  `list_files`/`read_file` on project `41ebafc1`) — it has component specimens, the FORM RECIPE (normative
  spacing), and the iOS-app kit for reference. Keep new components in `src/ui/`, bound to the tokens.

**Next UI work** (the redesign is BUILT — full spec in [`../ELECTRON-UI-DESIGN.md`](../ELECTRON-UI-DESIGN.md)):
- **macOS visual verify** (Ben) — `task ui:demo` / `ui:live`. Container can't render Electron.
- **`listFiles` + ad-hoc `deposit` + error states + upload progress — DONE ✅ (2026-06-24/25)** — browser
  tree is real journal data (`fixtures.ts` deleted), drop-to-upload really archives through the daemon, and
  failures surface (⚠ row from journal truth + sidebar panel that **names** files + Retry + light-red toast).
  Uploading rows show a **determinate** % bar for large solo-blob files (daemon `uploadProgress`), else an
  indeterminate stripe. All proven vs MinIO.
- **Remaining daemon contract** to activate the rest (each a source-swap, not a rebuild — mirror in
  `protocol.ts`, fetch/issue, swap the stand-in):
  - **move/rename/delete**, **exclude get/set**, **fee + bytes/cost** estimates (the placeholder numbers),
    a per-run **filesFailed** count.
- **Retry depth:** row Retry covers up-front (command-rejection) failures — we hold `srcPath`. A failure
  *after* the daemon accepts the upload (`blobFailed`) has no `srcPath` → needs daemon-side re-deposit/retry.
- **Polish:** native folder picker + `webUtils.getPathForFile` are **done** (deposit + request-a-copy) —
  still wanted for the Settings Add-folder field; `Show in Finder` (`shell.showItemInFolder` via IPC);
  macOS system notification on restore-ready; subset the 5.3 MB Material Symbols woff2.

## Gotchas

- **Pull current docs via the Context7 MCP.** Before wiring Electron/React/Vite (layers 2–3), reference
  up-to-date docs through Context7 — it's 2026, these APIs move; don't build from memory.
- **Tooling is Bun, runtime is Electron's Node.** electron-vite bundles main/preload; `externalizeDepsPlugin`
  keeps Node builtins external, so the layer-1 client keeps using Electron's `node:net`. `bun run dev/build`
  drives the electron-vite CLI; the app itself runs on Electron's bundled Node.
- **Security posture (layer 2).** `contextIsolation: true` + `nodeIntegration: false` — the renderer can't
  reach Node; it only sees `window.coldstore`. `sandbox: false` is the electron-vite default (ESM preload);
  the renderer loads only local bundled content (locked-down CSP), so the real boundary is contextIsolation.
  Tightening to `sandbox: true` (needs a CJS preload build) is a hardening follow-up.
- **macOS app, headless-Linux dev box.** The container can't render Electron, so it proves UI work by
  `task ui:typecheck` + `task ui:build` (all three processes compile) + `task ui:test` (real reducer +
  controller, headless) — *not* the look. **Visual verify is a macOS step.** Layers 1–3 are verified on
  macOS: the GUI runs, connects (`connection: connected`), and renders the skinned views live against the
  installed daemon (`task ui:live`, 2026-06-23).
- **`node_modules` can't be shared between the container and the Mac.** This is an Electron app, so
  `node_modules` contains platform-native binaries (electron, rolldown/vite, esbuild). The repo is
  bind-mounted into the Linux devcontainer, so a `bun install` run in the container leaves Linux
  binaries that the Mac can't load (`Cannot find module '@rolldown/binding-darwin-arm64'`, then the
  electron binary). **Each platform needs its own `node_modules`:** keep the container's in a named
  volume (so it doesn't sit on the bind mount) and run `bun install` once per platform. The
  Bun-on-tooling, Electron-on-its-own-Node split only holds *within one OS*.
- **Bun blocks postinstall scripts → Electron's binary isn't downloaded.** Electron fetches its app
  binary in a `postinstall`, which Bun skips by default (so a bare `bun install` leaves it missing and
  `electron-vite dev` dies with `Error: Electron uninstall`). **Handled by the Taskfile:** `task ui:dev`
  depends on `ui:_ensure-electron`, which downloads the binary if absent (idempotent — skipped once
  present); `task ui:setup` does it too. No manual step. (`electron` is also in package.json
  `trustedDependencies` for fresh installs.) `build`/`typecheck`/`test` don't need the binary.
- **Socket path:** `$COLDSTORE_SOCKET`, else `coldstorage/coldstored.sock` (dev). Installed path is
  `~/Library/Application Support/ColdStorage/coldstored.sock`. Socket is `0600` (owner-only).
- **Restore is idempotent/one-step** — `restore` returns `state ∈ restored|thawRequested|thawInProgress`;
  re-issue / reflect `restore*` events until `restored`. Don't expect one call to block for hours.
- **Browse is NOT R2-blocked — only thumbnails are.** The browse *tree* (paths/sizes/per-file status)
  renders from the **journal** (`files` table) via the daemon's `listFiles` read (**built 2026-06-24**),
  no R2/no thaw. Glacier freezes object *bytes*, never *metadata*; and our tree comes from the journal, not S3
  listing (we batch+encrypt into opaque `blobs/<hash>`). R2 is needed ONLY for photo **thumbnails** +
  cross-device index portability. (Corrected 2026-06-24.)
