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
| 3 | React views + design system (coldstorage DS, native-TSX port) | **DONE ✅** — macOS-verified live |

Toolchain: **electron-vite** (Vite, three-process split), **React 19**, secure IPC
(`contextIsolation: true`, `contextBridge`). Tooling runs on **Bun**; the Electron runtime is its own
bundled Node. Layer 3 skins the views in the **coldstorage Design System** (see [Design system](#design-system)).
Verified live on macOS against the installed launchd daemon (`task ui:live`).

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

src/preload/
  index.ts      contextBridge.exposeInMainWorld("coldstore", api) — the ONLY thing the renderer sees.

src/renderer/     The web app (React). No Node, no socket — talks to window.coldstore.
  index.html, src/main.tsx (font + style imports), src/useStore.ts, src/env.d.ts
  src/App.tsx     LAYER 3 — thin shell: sidebar routing + shared `exec` runner + error toast.
  src/state/
    reducer.ts      pure event-stream → AppState fold (+ eventAction constructor). Headless-testable.
    store.ts        tiny observable store (useSyncExternalStore-shaped).
    controller.ts   side-effecting glue: api events/lifecycle → store; refetch policy.
    *.test.ts       headless tests (bun test) — real reducer + real controller, fake api.
  src/styles/     LAYER 3 — tokens/ = the 5 DS token CSS files VENDORED verbatim (the SSOT, re-sync
                  don't hand-edit); app.css = component/shell styling (all var(--*)); index.css = entry.
  src/ui/         LAYER 3 — DS primitives ported to native TSX: primitives.tsx (Button, Card, Stat,
                  Badge, KeyValueRow, Field, EmptyState, Icon, Alert) + layout.tsx (Sidebar, Page).
  src/views/      LAYER 3 — VaultView (proof-of-safety wall), SourcesView, RestoreView + types.ts.
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

**UX polish backlog** (UX is a priority — handled in a dedicated agent track):
- Stat cards wrap **2-over-1** at narrow widths (auto-fit grid) — decide 3-up fixed vs. responsive.
- **Catch up now** is a no-op with 0 sources — consider disabling it until a source exists (the subtitle
  already guides to add a folder).
- **Native folder picker** for Add-source (main-process `dialog.showOpenDialog`) — today the path is typed.
- **Subset Material Symbols** — the bundled rounded woff2 is 5.3 MB (full set); subset to the ~12 glyphs used.
- **Browse view** — held, blocked on the R2 bucket; build (thumbnails + index) once infra lands.

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
- **Browse view is blocked on infra** (R2 bucket not scaffolded) — a disabled nav item until then;
  Vault/Sources/Restore are built and live.
