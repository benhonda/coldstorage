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

---

# Canonical design — the reorganizable filesystem (2026-06-24)

> **This supersedes the original 4-tab layout** (Vault / Sources / Restore / Browse) described under
> "Build order" → layer 3 below. The layer 1–2 infrastructure (socket client, secure IPC, event-fold
> store, the design system + tokens) is **unchanged and still correct**; only the *layout, navigation,
> and flows* are redesigned. Worked through with Ben in a dedicated UX session. Not yet built.

## The mental model
Two questions are the whole product: **"is my stuff safe?"** and **"can I get it back?"** The app answers
them as a **remote SSD you browse like a filesystem** — not a dashboard, not a sync-status panel.

- **Front door = the file browser itself.** An external drive has no "home dashboard"; you open it and
  see your files. Reassurance is **ambient** (per-file status badges + a "12 GB safe" line), never a
  separate screen of counts. *(This kills the original three-zeros Vault home and its wrong "Catch up
  now" hero button.)*
- **Ad-hoc deposit is the hero**, auto-watch is secondary. Two kinds of "stuff you can't lose": *living*
  (a Photos library that grows → wants watching) and *done* (a finished folder → just wants depositing
  once). The "I can't do AWS" user grasps **drag-it-in-and-it's-safe** more readily than configuring
  watched sources. So drop-to-archive is the front door; watched folders demote to Settings.
- **It's a real, reorganizable filesystem.** Move / rename / nest / new-folder / delete all work. This is
  cheap and honest because **the user's tree lives in the journal, not in S3 keys**: a move is a
  one-column `relativePath` edit (or a path-prefix sweep for a folder); the encrypted blob never moves,
  nothing thaws, nothing re-uploads. (The naive *path == S3 key* model is genuinely broken on Glacier —
  you can't even `CopyObject` a Deep-Archive object without a 12–48h restore first. The journal
  indirection dodges that entirely. Verified vs AWS docs.)
- **The one honest limit:** Deep Archive freezes *bytes*, never *metadata*. So you **browse instantly,
  always** (from the journal) — the multi-hour thaw only ever appears at the moment you ask for a file's
  *contents* back. The UI's whole job at that moment is to make a long wait feel calm and certain.

## Surfaces — two, not four
The 4 co-equal tabs collapse to:
- **My Files** — the entire drive: browse, drop-to-archive, reorganize, request-back. *(absorbs old
  Vault + Restore + Browse.)*
- **Settings** — watched folders, exclude patterns, storage/cost, restore location. *(absorbs old
  Sources.)*

```
┌──────────────┬──────────────────────────────────────────────────────┐
│ ❄ coldstorage│  My Files › Photos › 2019        ⊞ ⊟    ⊕ Add   ⋯    │
│              │ ┌──────────────────────────────────┬────────────────┐ │
│  My Files    │ │ Name          Size    Status      │  beach.jpg     │ │
│  Settings    │ │ 📁 January    1.2 GB  ☁           │  Photo · 4.1MB │ │
│              │ │ 📄 beach.jpg  4.1 MB  ☁ frozen  ◀ │  archived      │ │
│              │ │ 📄 sunset.jpg 3.8 MB  ⬇ here       │  Mar 3 2024    │ │
│              │ │ 📄 hike.mov   2.3 GB  ◌ getting…   │                │ │
│ ● Connected  │ │                                    │ [ Get it back ]│ │
│ 12 GB safe   │ └──────────────────────────────────┴────────────────┘ │
└──────────────┴── drop anywhere to archive · right-click for more ─────┘
```

## My Files — the browser
- **Navigation:** drill-in + breadcrumbs (click a folder → it becomes the view). Like iOS Files /
  Explorer — universally understood and it scales to an 8,000-photo folder where an inline tree would
  choke.
- **View:** list by default (name / size / status / date), with a **grid/gallery toggle** (`⊞ ⊟`) for
  photo folders — file-type icons today, thumbnails when R2 lands (the *only* R2-gated piece).
- **Per-file status badge** is the reassurance, always visible:
  - `☁ frozen` — safe in Deep Archive, not on disk. The default, reassuring state.
  - `◌ getting back` — thaw in flight; shows the quoted ready-by time.
  - `⬇ here` — thawed + downloaded, sitting locally.
  - `↑ archiving…` — mid-upload.
- **Selection → right-side inspector** (details + primary action `Get it back` / `Open`; also where the
  request-back quote previews) + **right-click context menu**. **Multi-select** (cmd/shift) drives batch
  restore / delete / move.
- **Empty / first-run:** a calm invitation, not three zeros — *"Drop files or folders here to keep them
  safe,"* one trust line ("encrypted on your Mac, then frozen in deep storage"), collapses to the file
  list once populated.
- **Manipulation = standard Finder gestures** (committed to the filesystem feel): rename (double-click →
  inline edit), new folder, drag-to-move, delete (⌫ → confirm). **Delete = instant tombstone** in the
  journal — honest copy: *"removes it from your files; it doesn't lower your cost for 180 days"* (Deep
  Archive's minimum-duration; never imply delete-to-save-money). Actual byte reclamation is deferred/rare
  (packed blobs need thaw-to-repack — a backend concern, invisible here).

## Deposit flow (the hero)
1. **Drop** anywhere (or ⊕ Add) → surface highlights, *"Drop to archive."* Items land in the
   currently-viewed folder (root if at root).
2. **Encrypt + upload** — daemon-owned, so **non-blocking**: browse / navigate / close the app, it
   continues. Aggregate headline (`Archiving 240 photos… 31 done`) + per-file `↑ archiving…` → `☁ frozen`
   badges updating live in the tree.
3. **Done = quiet inline confirmation** (no celebration, no notification): *"240 photos are frozen and
   safe. Skipped 1,203 files in node_modules and caches. see what →"*. The skip line is cost-protection
   made calm + factual — name the junk, **no salesy "saved you $X."**
4. **Edge states reflect the proven daemon honestly:** interrupted → resumes same `uploadId` (no
   re-upload); a blob fails → run continues, failure surfaced named (permanent vs transient); offline →
   queues.

## Request-back flow (the payoff + the honest limit)
1. **Trigger:** click a `☁ frozen` file → `Get it back` (double-click a frozen file = request; a `⬇ here`
   file = open). Works on one file, a multi-select, or a whole folder.
2. **Quote = explicit modal confirm** (paid + multi-hour → never accidental/optimistic): file · size ·
   **ready in ~a day (up to 48h)** · **cost ~$X** · **lands in Downloads/Restores** · "you can close the
   app — we'll fetch it and let you know."
3. **In-flight = named stages, NEVER a fake progress bar** (Deep Archive reports only "still warming" vs
   "ready", no %): **Warming up** (~12–48h, the honest unknown) → **Downloading** (mins) → **Verifying**
   (secs) → **Ready**. Badge shows a quoted ready-by time.
4. **Ready → `⬇ here` + a macOS system notification** (walk-away is the whole design): *"wedding.mov is
   back — in Downloads/Restores [Show] [Open]."*
5. **Edge:** the thawed copy expires after the requested `days`, then re-freezes → honest *"available
   until Jun 28,"* re-fetch is one click.
6. A **persistent "getting back" indicator** lives in the shell so an in-flight restore is visible
   everywhere and survives app close (the daemon owns the thaw; the UI reflects it).
7. **Batch/folder restore** → one **combined** quote (`getting back 240 files · ~a day · ~$3.10`) so cost
   stays certain.

## Settings
- **Watched folders** (demoted auto-sync): list + Add folder; **"Catch up now" lives here** (only
  meaningful with watched folders — no longer a home hero). Their *archived contents* still appear in My
  Files (with a small "auto" marker); Settings holds the *rule*, My Files the *stuff*.
- **Don't back up** (excludes): **friendly removable chips**, seeded with smart defaults
  (`node_modules` `.DS_Store` `*.tmp` `.git` …), "+ add a pattern" types a glob — a plain "don't back up"
  list to the non-technical user, real globs under the hood. Scope: **global + per-source** (per-source
  extras hang off each watched folder's `⋯`, a later refinement; global ships first). gitignore-style
  semantics (reuse, don't invent a matcher).
- **Storage:** calm + factual — *"12 GB safe · ~$0.05/month · encrypted on this Mac"* (honest trust line,
  no zero-knowledge / privacy over-claim beyond V1).
- **Restores land in** — the default the request-back quote references, changeable.

## Daemon contract gaps this design needs (the build spec)
The UI is a thin client; this design needs data/commands the daemon doesn't expose yet. **None block the
*design*; each is a precise backend ask** (Ben's lane). Most are small reads over the journal, which
already holds the data.
- **`listFiles` (read).** Return the browsable tree from the journal — `relativePath, size, status,
  blobId` already exist in the `files` table (`Journal.swift`). The single command that unblocks the
  whole browser. *No R2, no thaw.*
- **Per-file live status.** Browser badges need `frozen | archiving | gettingBack | here` per file —
  fold the journal `FileStatus` with the live restore state (today restore state is per-request via
  `restore*` events, not queryable per file).
- **Bytes / size in `Status`.** "12 GB safe" + per-folder rollups. Per-file `size` exists in the journal;
  `Status` exposes only counts — add a total-bytes field (and ideally per-prefix sums).
- **Restore *fee* estimate.** The quote shows cost; `restore`/`RestoreStep` exposes `typicalWait` but
  **no fee**. Add an estimated-cost field (and a combined estimate for batch/folder restore).
- **Ad-hoc one-shot deposit command.** Distinct from `addSource` (which registers a *watched* source) —
  "archive these paths once, don't watch." The hero gesture needs an ingest path that doesn't leave a
  phantom watched folder.
- **Exclude patterns (get/set).** Global + per-source globs, applied at scan time; gitignore semantics.
- **Skipped-count reporting.** The deposit "skipped 1,203 (node_modules…)" line needs the run to report
  what the excludes filtered (an event field or `runFinished` addition).
- **Filesystem ops:** `move`/`rename` (journal `relativePath` edit / prefix sweep — cheap, no S3), `delete`
  (tombstone in journal; **decouple from byte reclamation** — defer GC, mind the 180-day min +
  thaw-to-repack cost), `newFolder` (virtual path).
- **Cost/storage estimate.** GB stored + rough monthly cost for the Storage panel.
- **(UI/main-process, not daemon):** macOS **system notification** on restore-ready.

**Backend concerns flagged (not UI contract, but load-bearing — see ROADMAP):** the **journal is the
crown-jewels SPOF** — losing it makes the opaque-ciphertext archive unrecoverable; it needs first-class
durability (hot, versioned, replicated, snapshotted) + a cross-device conflict story before "mirror to
R2" is real. And **delete/GC** on packed Deep-Archive blobs is genuinely expensive (thaw-to-repack +
early-deletion penalties) — tombstone now, reclaim rarely/in batches.

**R2-gated, and ONLY this:** photo **thumbnails** (can't preview a frozen blob — capture at archive-time,
store hot) and **cross-device index portability** (a fresh Mac has no journal). Everything else in this
design works against the journal today.

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
   can't render Electron here.
   *Later optimization:* subset the 5.3 MB Material Symbols woff2 to the ~12 glyphs used.
   > ⚠️ **LAYOUT SUPERSEDED (2026-06-24).** The 4-tab Vault/Sources/Restore/Browse layout these views
   > implement is replaced by the **reorganizable-filesystem design** (see "Canonical design" at the top).
   > The **primitives, tokens, fonts, `app.css`, and the layer-1/2 plumbing stay** — it's the *views,
   > nav, and flows* that get rebuilt (My Files browser + Settings). Don't extend the old 4 views; build
   > toward the canonical design.

## Dependencies & gotchas (save the next agent hours)
- **Browse is NOT R2-blocked — only thumbnails are (corrected 2026-06-24).** Earlier notes said the whole
  "browse your archive" view waits on R2. Wrong. The **browse *tree* (paths/sizes/per-file status) renders
  from the journal today** — `files(relativePath, size, status, blobId, …)` in `Journal.swift` already IS
  the index; the daemon just needs one new read command (a `SELECT`, a `listFiles`). Two facts: Glacier
  Deep Archive freezes object **bytes**, never **metadata** (LIST/HEAD stay live; only `GetObject` thaws),
  and **our tree doesn't come from S3 listing anyway** — we batch+encrypt many files into opaque
  `blobs/<hash>` objects, so the journal, not `ListObjectsV2`, is the SSOT for the tree. R2 is needed ONLY
  for (a) **photo thumbnails** (can't preview a frozen blob — capture at archive-time, store hot) and (b)
  **cross-device portability** of the index (a fresh Mac has no journal). So: tree/list view + restore work
  with no infra; the **thumbnail grid** is the only R2-gated piece. Don't block browse on R2.
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
Layers 1 + 2 are done ✅ + verified on macOS (socket client, secure IPC, event-fold store, DS tokens +
primitives + fonts). Layer 3 was built as the **4-tab layout**, now **superseded** by the
**Canonical design** at the top of this doc (the reorganizable filesystem). The plumbing + design system
stay; the views/nav/flows get rebuilt. **Remaining UI work, in order:**

1. **Rebuild the views to the canonical design** — collapse 4 tabs → **My Files** (drill-in file browser:
   list/grid, status badges, inspector + context menu, drop-to-archive, reorganize, request-back modal)
   **+ Settings** (watched folders, exclude chips, storage, restore location). Reuse the existing
   primitives/tokens; add the few new ones the browser needs (tree row, breadcrumb, inspector, modal,
   drop overlay). Keep `App.tsx` a thin routing shell.
2. **Grow the daemon contract to match** — see "Daemon contract gaps this design needs" above. The
   unblocking one is **`listFiles`** (journal `SELECT` → the browser's tree). The rest (ad-hoc deposit,
   excludes, fee estimate, move/rename/delete, bytes/cost) are Ben's backend lane; the UI binds to the TS
   mirror as each lands. Design the views to a clear data model now; render from realistic fixtures where
   the daemon is behind.
3. **macOS visual verify** (Ben) — `task ui:demo` / `task ui:dev` vs `task daemon:run`. Electron can't
   render in the container.
4. **Polish:** native folder picker (`dialog.showOpenDialog`) for Add-source; macOS system notification
   on restore-ready; subset the 5.3 MB Material Symbols woff2 to the glyphs actually used.

When extending: components live in `src/renderer/src/ui/` (bound to the vendored token vars in
`styles/tokens/` — the DS SSOT, re-sync don't hand-edit). **Pull current docs via the Context7 MCP**
before deep React/Vite/Electron work.
