# ColdStorage — Electron/React UI design brief

> For the next agent (who'll have the Electron skill). This is the *plan + decisions in force*, not a spec.
> The daemon (`coldstored`) is built, proven, and is the whole backend — the UI is a **thin client over its
> control socket**. Read [`ROADMAP.md`](./ROADMAP.md) first, then the control-plane section of
> [`coldstorage/README.md`](./coldstorage/README.md).

## What the UI is
A control panel for `coldstored`: browse your files, drop files in to upload, reorganize, watch live
progress, and request a copy back. It holds **no upload/restore logic** — the Swift daemon owns
scan/encrypt/upload/restore/journal. The UI reads state and sends commands. Brand surface is plain and
factual — a file uploader, not a vault that advertises safety (see the VOICE note below).

---

# Canonical design — the reorganizable filesystem (2026-06-24)

> **This supersedes the original 4-tab layout** (Vault / Sources / Restore / Browse) described under
> "Build order" → layer 3 below. The layer 1–2 infrastructure (socket client, secure IPC, event-fold
> store, the design system + tokens) is **unchanged and still correct**; only the *layout, navigation,
> and flows* are redesigned. Worked through with Ben in a dedicated UX session.
>
> **BUILT 2026-06-24 ✅ — pending macOS visual verify.** My Files browser + Settings ship in [`ui/`](./ui/);
> the old 4-tab views are deleted, primitives/tokens/plumbing kept. `task ui:typecheck` + `ui:test` +
> `ui:build` green. The browser tree renders from **fixtures** (`ui/src/renderer/src/views/files/fixtures.ts`
> — a `listFiles` stand-in); request-a-copy issues the **real `restore` command**; deposit/move/rename/delete
> are optimistic-local seams (honest — cheap journal edits in the real design). See the contract gaps below
> for what makes each real.

> **VOICE — plain file-uploader, no reassurance theater (Ben, 2026-06-24).** Don't tell the user their
> files are "safe," don't claim/advertise safety, don't editorialize ("steady", "reassuring"). It's a
> file uploader; they know why they're using it. Use plain, factual verbs: **upload** (not "archive" as
> the active verb), **stored** (not "safe"), **request a copy** / **Start transfer** / **Transferring**
> (not "download"/"retrieve"/"get it back" — those imply immediacy; the slow-thaw nuance lives in the
> dialog, not the label), **frozen** (factual: deep storage is slow to open). Status is *information*, not
> comfort. (Extends [no fear-mongering] — same principle, other direction: neither alarm nor reassurance,
> just facts.)

## The mental model
Two jobs are the whole product: **get files up** and **get them back**. The app does them as a
**drive you browse like a filesystem** — not a dashboard, not a sync-status panel.

- **Front door = the file browser itself.** An external drive has no "home dashboard"; you open it and
  see your files. Status is **ambient** (per-file badges + a plain storage line), never a separate screen
  of counts. *(This kills the original three-zeros Vault home and its wrong "Catch up now" hero button.)*
- **Ad-hoc deposit is the hero**, auto-watch is secondary. Two kinds of files people keep: *living*
  (a Photos library that grows → wants watching) and *done* (a finished folder → just wants uploading
  once). The "I can't do AWS" user grasps **drag-it-in-and-it-uploads** more readily than configuring
  watched sources. So drop-to-upload is the front door; watched folders demote to Settings.
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
- **My Files** — the entire drive: browse, drop-to-upload, reorganize, download a copy. *(absorbs old
  Vault + Restore + Browse.)*
- **Settings** — watched folders, exclude patterns, storage/cost. *(absorbs old Sources.)*

The sidebar is **resizable** (drag the seam; clamped + persisted). No docked detail panel — selecting a
row just selects it; the `⋯` per-row dropdown (and right-click) opens actions, **Get info** opens a modal.

```
┌────────────┬────────────────────────────────────────────────────────┐
│ ❄ coldstor.│  My Files › Photos › 2019              ⊞ ⊟    ⊕ Add      │
│            │  Name                          Size      Date            │
│  My Files  │  📁 January                    1.2 GB    12 items        │
│  Settings  │  📄 beach.jpg                  4.1 MB    Jul 12 2019  ✓ ⋯ │
│            │  📄 sunset.jpg                 3.8 MB    Jul 12 2019  ↓ ⋯ │
│            │  📄 hike.mov                   2.3 GB    Aug 3 2019      │
│            │                                                          │
│ 12 GB      │                                                          │
│Transferring 1│ ────── drop anywhere to upload · right-click for more ─│
└────────────┴────────────────────────────────────────────────────────┘
   ⋯ → Get info · Rename · Move to… · New folder · Request a copy… · Delete
   (status = a small colored icon by the ⋯: ↑ uploading · ↓ transferring · ✓ saved;
    frozen rows show none — the resting default, not news)
```

## My Files — the browser
- **Navigation:** drill-in + breadcrumbs (click a folder → it becomes the view). Like iOS Files /
  Explorer — universally understood and it scales to an 8,000-photo folder where an inline tree would
  choke.
- **View:** list by default (name / size / date — **no status column**), with a **grid/gallery toggle**
  (`⊞ ⊟`) — file-type icons today, thumbnails when R2 lands (the *only* R2-gated piece).
- **Status is a small colored ICON by the row's `⋯`, NOT a column or a text pill** (Ben, 2026-06-24).
  `frozen` is the resting default → **no icon** (a marker on every row is noise). An icon shows only when
  there's something true to say (fixed-width slot so rows stay aligned with or without one):
  - upload icon, accent blue — **uploading** (mid-upload).
  - down-arrow-circle icon, amber — **Transferring** (a copy is on its way; queue shows Preparing →
    Downloading → Ready + ready-by).
  - green **check** — a copy is saved on this Mac.
- **Selection is just selection** — clicking a row selects it (cmd/shift for multi → batch ops); it does
  **not** auto-open a panel. **Details live behind a dropdown**: a per-row `⋯` (and right-click) opens
  the actions menu; **Get info** opens a details modal. Double-click a file → Get info; a folder → drill
  in. *(No docked side-inspector — Ben, 2026-06-24: details belong under a dropdown, not a panel that
  opens on click.)*
- **Getting a copy back is a SECONDARY action, never a promoted CTA.** The product's job is to upload +
  hold files; getting a copy back is *available, not advertised* (Ben, 2026-06-24). It lives in the row
  menu and the Get-info modal (a low-key button), labeled **"Request a copy…"** — *request* signals it's
  not instant (not "download"/"retrieve"/"get it back", which all imply immediacy). The dialog's confirm
  button is **"Start transfer"** and the dialog owns the "ready in ~a day" detail. In-flight status reads
  **Transferring** (not "downloading" — that implies it's actively loading onto the disk, but most of the
  wait is the deep-storage thaw; "transferring" matches the Start-transfer action).
- **Empty / first-run:** a plain invitation, not three zeros — *"Drop files or folders here to upload
  them,"* one factual line ("encrypted on your Mac before upload"), collapses to the file list once
  populated. **Delete-empty-folder skips the confirm** (no bytes at stake → just remove it; the
  180-day-cost copy only shows when real uploaded bytes are involved).
- **Manipulation = standard Finder gestures** (committed to the filesystem feel): rename (double-click →
  inline edit), new folder, drag-to-move, delete (⌫ → confirm). **Delete = instant tombstone** in the
  journal — honest copy: *"removes it from your files; it doesn't lower your cost for 180 days"* (Deep
  Archive's minimum-duration; never imply delete-to-save-money). Actual byte reclamation is deferred/rare
  (packed blobs need thaw-to-repack — a backend concern, invisible here).

## Deposit flow (the hero)
1. **Drop** anywhere (or ⊕ Add) → surface highlights, *"Drop to upload."* Items land in the
   currently-viewed folder (root if at root).
2. **Encrypt + upload** — daemon-owned, so **non-blocking**: browse / navigate / close the app, it
   continues. Aggregate headline (`Uploading 240 photos… 31 done`) + per-file `↑ uploading…` → `❄ frozen`
   badges updating live in the tree.
3. **Done = quiet inline confirmation** (no celebration, no notification): *"240 photos uploaded. Skipped
   1,203 files in node_modules and caches. see what →"*. The skip line is cost-protection made factual —
   name the junk, **no salesy "saved you $X,"** no "safe."
4. **Edge states reflect the proven daemon honestly:** interrupted → resumes same `uploadId` (no
   re-upload); a blob fails → run continues, failure surfaced named (permanent vs transient); offline →
   queues.

## Request-a-copy flow (available, not advertised — the honest limit)
1. **Trigger:** the **secondary** "Request a copy…" action — in the row `⋯` menu or the Get-info modal
   (never a primary CTA, never the double-click default; double-click = Get info). Works on one file, a
   multi-select, or a whole folder.
2. **Confirm = explicit modal** (paid + multi-hour → never accidental/optimistic), button **"Start
   transfer"**: file · size · **ready in ~a day (up to 48h)** · **cost ~$X** · **a "Save to" row with the
   native folder picker** (`dialog.showOpenDialog`, a window sheet on macOS — no typing; defaults to the
   OS Downloads dir, chosen per request, no global setting) · "you can close the app — we'll fetch it and
   let you know."
3. **In-flight = named stages, NEVER a fake progress bar** (Deep Archive reports only "still warming" vs
   "ready", no %): **Preparing** (~12–48h, the honest unknown) → **Downloading** (mins) → **Ready**. Badge
   shows a quoted ready-by time.
4. **Ready → `⬇ here` + a macOS system notification** (walk-away is the whole design): *"wedding.mov is
   ready — in your Downloads folder [Show] [Open]."*
5. **Edge:** the local copy expires after the requested `days`, then re-freezes → honest *"available
   until Jun 28,"* download again is one click.
6. A **persistent "Transferring N" indicator** lives in the shell (sidebar foot, clickable → the queue
   popover) so an in-flight transfer is visible everywhere and survives app close.
7. **Batch/folder request** → one **combined** quote (`transferring 240 files · ~a day · ~$3.10`) so cost
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
- **Storage:** plain + factual — *"12 GB stored · ~$0.05/month · encrypted on this Mac"* (no "safe", no
  zero-knowledge / privacy over-claim beyond V1).
- **No "download location" setting** — removed (Ben, 2026-06-24). Downloading is rare, so the destination
  is chosen per download in the dialog, not maintained as a global preference.

## Daemon contract gaps this design needs (the build spec)
The UI is a thin client; this design needs data/commands the daemon doesn't expose yet. **None block the
*design*; each is a precise backend ask** (Ben's lane). Most are small reads over the journal, which
already holds the data.
- **`listFiles` (read).** Return the browsable tree from the journal — `relativePath, size, status,
  blobId` already exist in the `files` table (`Journal.swift`). The single command that unblocks the
  whole browser. *No R2, no thaw.*
- **Per-file live status.** Browser status icons need `frozen | uploading | gettingBack | here` per file —
  fold the journal `FileStatus` with the live restore state (today restore state is per-request via
  `restore*` events, not queryable per file).
- **Bytes / size in `Status`.** "12 GB stored" + per-folder rollups. Per-file `size` exists in the journal;
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
   `layout.tsx` = Sidebar + Page); `src/renderer/src/views/` (the original 4-tab views — now deleted, see
   the callout below). `App.tsx` is a thin shell (sidebar routing + a shared `exec` + an error toast). **Fonts
   self-hosted** (`@fontsource/hanken-grotesk`, `@fontsource/jetbrains-mono`, `material-symbols`) so they
   bundle same-origin under the renderer's locked-down CSP (`default-src 'self'`) — the DS's Google-Fonts
   `@import` would have been blocked. **Proven:** `task ui:typecheck` + `task ui:build` green.
   **PENDING Ben (macOS):** visual verify via `task ui:demo` (or `task ui:dev` vs `task daemon:run`) —
   can't render Electron here.
   *Later optimization:* subset the 5.3 MB Material Symbols woff2 to the ~12 glyphs used.
   > ✅ **REBUILT to the canonical design (2026-06-24).** The 4-tab Vault/Sources/Restore/Browse views are
   > deleted; **My Files** (browser) + **Settings** ship in their place (`src/views/MyFilesView.tsx`,
   > `SettingsView.tsx`, `views/files/`). The primitives/tokens/fonts/`app.css`/layer-1/2 plumbing were
   > kept and extended (added `Chip` + `Modal` primitives, a `Page` `fill` mode, a Sidebar foot slot).
   > `task ui:typecheck` + `ui:test` + `ui:build` green; macOS visual verify pending.

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
Layers 1 + 2 done ✅ + verified on macOS. Layer 3 **rebuilt to the canonical design (2026-06-24)** —
**My Files** browser + **Settings** ship in [`ui/`](./ui/); old 4-tab views deleted; primitives/tokens/
plumbing kept + extended (added `Chip`/`Modal`, `Page.fill`, Sidebar foot). `task ui:typecheck`+`ui:test`+
`ui:build` green. The data model is in `ui/src/renderer/src/views/files/model.ts` (pure, headless-tested);
the tree is seeded from `fixtures.ts`. **Remaining UI work, in order:**

1. **macOS visual verify** (Ben) — `task ui:demo` / `task ui:dev` vs `task daemon:run`. Electron can't
   render in the container. *(Caveat: against the current fixtures + empty vault, clicking Get-it-back
   issues the real `restore` command for a fixture id the daemon can't match → an honest "unknown file"
   error. The modal/quote/confirm flow still verifies; the post-confirm badge transition needs real ids
   from `listFiles`.)*
2. **Grow the daemon contract to activate the seams** — see "Daemon contract gaps this design needs"
   above. **`listFiles`** (journal `SELECT`) is the unblocker: it replaces `fixtures.ts` with real journal
   files, which also makes request-a-copy resolve end-to-end. Then ad-hoc **deposit**, **move/rename/delete**,
   exclude get/set, and **fee + bytes/cost** estimates turn the optimistic-local ops (`useFiles.ts`) and
   placeholder numbers real. As each lands: mirror it in `protocol.ts`, fetch/issue in the controller/view,
   swap the stand-in. The UI already binds to a clear data model, so this is a source swap, not a rebuild.
3. **Polish:** native folder picker (`dialog.showOpenDialog`) for Add-folder; `Show in Finder`
   (`shell.showItemInFolder` via IPC); dropped-file paths via `webUtils.getPathForFile` in the preload
   (Electron 32+ removed `File.path`); macOS system notification on restore-ready; subset the 5.3 MB
   Material Symbols woff2 to the glyphs used.

When extending: generic primitives live in `src/renderer/src/ui/` (bound to the vendored token vars in
`styles/tokens/` — the DS SSOT, re-sync don't hand-edit); the browser's domain components + model live in
`src/renderer/src/views/files/`. **Pull current docs via the Context7 MCP** before deep React/Vite/Electron
work.
