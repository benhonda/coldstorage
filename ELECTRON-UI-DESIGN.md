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
> `ui:build` green. **The browser tree is now real journal data** — the daemon's `listFiles` read is built
> and the fixtures stand-in is deleted (proven vs MinIO, `task ui:prove`). Request-a-copy issues the
> **real `restore` command** (resolves end-to-end now that ids are real journal ids);
> **drop-to-upload / "Choose files" really archive through the daemon** (the `deposit`
> command — proven vs MinIO); **move/rename/delete are real daemon commands** too (`movePath`/`deletePath`
> — journal `relativePath` prefix-sweep + tombstone, `filesChanged` event reconciles the optimistic edit;
> proven vs MinIO, 2026-06-25). **Excludes + cost/fee are now built too (2026-06-25)** — see the contract gaps below; what remains is small (per-file live status, skipped-count reporting).

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
   (status = a small colored icon by the ⋯: ✓ stored · ↑ uploading · ⚠ couldn't upload ·
    ↓ transferring · ⤓ saved on this Mac; no icon = nothing in flight. revised 2026-06-24)
```

## My Files — the browser
- **Navigation:** drill-in + breadcrumbs (click a folder → it becomes the view). Like iOS Files /
  Explorer — universally understood and it scales to an 8,000-photo folder where an inline tree would
  choke.
- **View:** list by default (name / size / date — **no status column**), with a **grid/gallery toggle**
  (`⊞ ⊟`) — file-type icons today, thumbnails when R2 lands (the *only* R2-gated piece).
- **Status is a small colored ICON by the row's `⋯`, NOT a column or a text pill** (Ben, 2026-06-24).
  **REVISED 2026-06-24 (later, after a silent upload failure read as "nothing happened"):** stored is
  **not** blank — it shows a quiet ✓, so the user can tell *stored* from *stuck* at a glance. Explicit
  success is what makes silence trustworthy; absence of any icon then cleanly means "nothing in flight."
  The states (circle family, fixed-width slot so rows stay aligned):
  - green **check** (`check_circle`, quiet) — **stored** (the common at-rest state).
  - up-arrow-circle, accent blue — **uploading** (mid-upload; **a transient retry stays here** — it
    self-heals, so we don't alarm).
  - **error circle, red (muted, not alarm-red)** — **couldn't upload**: a *permanent/stuck* failure the
    daemon stopped retrying. Also surfaced persistently in the sidebar ("N couldn't upload" → a failures
    panel + Try again), because a one-shot toast gets missed.
  - down-arrow-circle, amber — **Transferring** (a copy is on its way; queue shows Preparing →
    Downloading → Ready + ready-by).
  - `download_done`, green — a copy is **saved on this Mac** (re-glyphed off the plain ✓ now that ✓ = stored).
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
- **Empty / first-run:** a plain invitation, not three zeros — a **bounded, clickable drop-zone card**
  filling the content area (icon medallion + *"Drop files or folders to upload"* + one factual line
  "encrypted on your Mac before upload" + a **"Choose files"** CTA). The **whole zone is clickable** →
  opens the native file dialog (same as the header **Add**); hover lifts it. Collapses to the file list
  once populated. **Delete-empty-folder skips the confirm** (no bytes at stake → just remove it; the
  180-day-cost copy only shows when real uploaded bytes are involved).
- **Manipulation = standard Finder gestures** (committed to the filesystem feel): rename (**press-and-hold
  the name** → inline edit, or the ⋯/right-click menu — NOT double-click, which *opens* the row), new
  folder, drag-to-move, delete (⌫ → confirm). **Delete = instant tombstone** in the
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
5. **Name collisions are Finder-style, never silent — DONE ✅ (2026-06-29).** A deposit feels like a remote
   SSD: dropping into a *new* folder copies (each item a new file — photos are path-keyed now, `id ==
   relativePath`, so the same photo in two folders is two copies, not a silent move). Dropping names that
   already exist in the target folder PROMPTS (`CollisionModal`): per-file **Keep Both** (saves `name 2.ext`)
   / **Replace** (overwrites) / **Skip**, with an *apply-to-all*, defaulting to Keep Both (never lose data).
   Mechanics: the UI calls `previewDeposit` (a no-upload dry-run that resolves where each item lands — via the
   *real* source, so picked-photo filenames resolve too — and flags which already exist); on collisions it
   shows the modal, then issues `deposit`/`depositPhotos` with a `conflicts` map (vault relativePath →
   policy) that the daemon's `CollisionResolvingSource` applies authoritatively. Copies re-upload their bytes
   (content-addressed blob dedup is a deferred, UX-invisible storage optimization). **PENDING Ben (macOS):
   visual-verify the modal.**

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
- **Watched folders** (demoted auto-sync): a list + **Add a watched folder**; **"Sync now" lives here**
  (a global catch-up; only meaningful with watched folders — no longer a home hero). Each row is a
  **rounded accent folder tile + source → destination** (the `~`-shortened Mac path over `↳ My Files /
  <mount>`), an at-a-glance **status badge** (🟢 Up to date · 🔵 Syncing… · 🟠 Not watching — driven by the
  live `run.active`, since `status.running` only updates on a getStatus poll and so never reflects an
  in-flight scan), and a ghost **⋯** holding **Stop / Start watching** (the reversible per-source pause)
  and **Remove…** (a confirm dialog — uploaded files stay in My Files). Their *archived contents* still
  appear in My Files (with a small "auto" marker); Settings holds the *rule*, My Files the *stuff*.
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
The UI is a thin client; this design needs data/commands from the daemon — **most now built** (`listFiles`,
`deposit`, `movePath`/`deletePath`, `uploadProgress`, per-file `failed`, **excludes** + **`getPricing`**);
the rest below are still open.
**None block the *design*; each is a precise backend ask** (Ben's lane). Most are small reads/edits over
the journal, which already holds the data.
- **`listFiles` (read) — DONE ✅ (2026-06-24).** Returns the browsable tree from the journal —
  `{id, relativePath, size, status, blobId}` straight off the `files` table (`Journal.listFiles`, a pure
  `SELECT ORDER BY relativePath`; wired in `DaemonService.handle`, mirrored in `protocol.ts` as
  `ListedFile`, folded into the store as `state.files`, mapped to the browser model by
  `model.fileFromJournal`). **The fixtures stand-in is deleted** — the browser tree is real journal data.
  Proven end-to-end vs MinIO (`task ui:prove` → `listFiles → N file(s)`; raw shape confirmed via
  `task daemon:ctl -- listFiles`). *No R2, no thaw.* Note `status` is the raw journal `FileStatus`
  (today `planned`/`archived`/`failed` persist per file; the UI coarsens to frozen/uploading/failed).
- **Per-file live status.** Browser status icons need `frozen | uploading | failed | gettingBack | here`
  per file — fold the journal `FileStatus` with the live restore state (today restore state is per-request
  via `restore*` events, not queryable per file).
- **Upload-failure surfacing (per-file) — DONE ✅ (2026-06-24/25).** *Why it mattered:* a failed upload was
  **invisible** (Ben, 2026-06-24 — "I saw nothing"). Failures classify per-BLOB, but the surfacing is now
  per-file and backed by journal truth: (1) `blobFailed {blob, kind, message, paths}` names the files —
  `paths` is the newline-joined relativePaths of every file in the failed blob — so the panel says *which*
  files, not a blob hash; (2) a **permanent** failure calls `Journal.markFilesFailed` to persist a per-file
  **`failed`** status, so `listFiles` returns it → the per-row ⚠ survives a refresh + a restart (not a UI
  guess). The UI side: a persistent sidebar "couldn't upload" count → a failures panel (from
  `state.failures`, **permanent only** — transient blips stay "uploading" and self-heal, Ben's call) +
  "Try again" (`triggerNow`). *Error copy is Ben-gatekept (placeholders in the UI).* **Still open:** a
  per-run **filesFailed** count (blobs ≠ files).
- **Upload progress (per-file byte %) — DONE ✅ (2026-06-24).** Uploading rows show a **determinate** bar
  (real percent of bytes up). The engine's multipart loop emits **`uploadProgress {file, path, bytes,
  totalBytes}`** once per 64 MiB part, for **solo (large-file) blobs only** — the case where a determinate
  bar is meaningful; small batched files flip to ✓ near-instantly and keep the indeterminate stripe. The UI
  matches the row by id-or-path and fills the bar live, even for one big file. Proven vs MinIO (a ~200 MB
  deposit streamed 4 monotonic ticks 32→64→96→100%).
- **Bytes / size — RESOLVED by design (2026-06-25).** No `Status` field needed: per-file `size` rides every
  `listFiles` row, so the renderer derives "12 GB stored" + per-folder rollups from the tree it already holds
  (`totalBytes(files)` / the folder model). Adding a `storedBytes` to `Status` would be a *second* source of
  the same number (divergence risk) — deliberately not done; the journal tree is the SSOT.
- **Restore *fee* estimate — DONE ✅ (2026-06-25).** A daemon **`getPricing`** rate-card command (storage
  $/GB-mo + per-tier retrieval $/GB, co-located on `RestoreTier`, with an honest estimate disclaimer) is the
  pricing SSOT. The request-a-copy modal quotes fee + wait from it at the standard tier; Settings quotes the
  monthly storage estimate. Replaced two divergent hardcoded magic numbers. Proven vs MinIO
  (`task ui:prove` → `getPricing → storage=$0.00099/GB-mo · standard=$0.02/GB`). Batch/folder restore already
  sums bytes, so the combined quote falls out of the same per-GB math.
- **Ad-hoc one-shot deposit command — DONE ✅ (2026-06-24).** `deposit {src, dest}` (newline-joined
  absolute paths + a vault-relative target folder) archives the dropped paths once with NO watched source
  — the proven pipeline over an `ExplicitPathsSource`, fire-and-forget, progress via the usual
  runStarted/fileArchived/blobFailed/runFinished events. The UI's drag-drop + "Choose files" resolve real
  paths in the preload (`webUtils.getPathForFile`, Electron 32+ removed `File.path`) and issue it. Proven
  end-to-end vs MinIO (`task daemon:deposit-ipc SRC=… DEST=…` → file reaches `archived`, blob lands in
  MinIO). *Note:* a deposit that FAILS isn't auto-retried by the run loop (it's not a watched source) — it
  surfaces via `blobFailed` (→ the "couldn't upload" panel) and needs a re-drop; auto-retry of failed
  deposits is a later refinement.
- **Exclude patterns (get/set) — DONE ✅ (2026-06-25).** Global gitignore-style globs, journal-persisted
  (the daemon seeds the smart defaults once on first run + is the SSOT — the UI fetches them, no longer
  hardcodes). Commands `listExcludes`/`addExclude`/`removeExclude` + an `excludesChanged` event; Settings'
  "Don't back up" chips are daemon-backed. **Applied *inside the directory walk*** (`LocalDirSource`) so an
  excluded file is never hashed and an excluded folder (node_modules) is pruned whole — covering scheduled
  scans + dropped folders (an explicitly dropped single file is honored as-is). Proven end-to-end vs MinIO.
  *(Per-source globs remain a later refinement; global ships now.)*
- **Skipped-count reporting — still open.** The deposit "skipped 1,203 (node_modules…)" line needs the run
  to report *how many* the excludes filtered (an event field or `runFinished` addition). Excludes themselves
  now exist (above); only the count surfacing is unbuilt.
- **Filesystem ops — move/rename/delete DONE ✅ (2026-06-25).** One primitive `movePath {from, to}` backs
  both file/folder **move AND rename** (a rename is a move to a sibling path) — a journal `relativePath`
  prefix-sweep, cheap, no S3, the blob never moves; the stable `id` (the upsert dedup key) is preserved so
  a rescan won't re-upload. `deletePath {path}` **tombstones** the subtree (`status=deleted`, row + blob
  mapping kept — byte reclamation is decoupled/deferred: 180-day min + thaw-to-repack cost). Both emit
  `filesChanged` → the UI reconciles its optimistic edit on the next `listFiles`. Proven vs MinIO
  (`task daemon:move-ipc`/`daemon:delete-ipc`). Still local-only: `newFolder` (a virtual path with no
  files yet — nothing to persist until something lands in it).
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
- **Commands (SSOT = `DaemonService.handle`):** `ping · getStatus · listSources · listFiles · addSource ·
  removeSource · previewDeposit · deposit · depositPhotos · movePath · deletePath · createFolder ·
  listExcludes · addExclude · removeExclude · getPricing · triggerNow · pauseSource · resumeSource · restore`.
- **Events (SSOT = `DaemonEvent(...)` call sites):** `runStarted · fileArchived · uploadProgress · runFinished ·
  blobFailed · sourcesChanged · filesChanged · restoreRequested · restoreInProgress · restoreCompleted · paused ·
  resumed · error`. `uploadProgress` carries `{file, path, bytes, totalBytes}`; `blobFailed` carries `{blob,
  kind, message, paths}` (newline-joined relativePaths); `filesChanged` carries `{moved, to}` XOR `{deleted}`
  (the path(s) a `movePath`/`deletePath` touched — the UI's cue to re-read `listFiles`).
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
Layers 1 + 2 done ✅ + verified on macOS. Layer 3 = the canonical design, BUILT and substantially wired to
the real daemon (2026-06-24). **My Files** browser + **Settings** ship in [`ui/`](./ui/); old 4-tab views
deleted. `task ui:typecheck` + `ui:test` (44) + `ui:build` green. The data model is in
`ui/src/renderer/src/views/files/model.ts` (pure, headless-tested); the tree is the daemon's `listFiles`
(no more fixtures).

**Real against the daemon now (all proven vs MinIO):** `listFiles` (browser tree), `deposit`
(drop-to-upload / "Choose files" — `ExplicitPathsSource`, paths resolved via preload `webUtils.getPathForFile`),
`restore` (request-a-copy), and `movePath`/`deletePath` (reorganize move/rename + delete — optimistic edit
then reconcile on the `filesChanged`-triggered `listFiles` refetch). **Error states built (UI side):** a failed upload shows ⚠ **couldn't upload**
ON the row (kept visible, not vanished/not stuck-blue), a **light-red error toast**, a persistent sidebar
**"N couldn't upload"** count → `FailuresPanel` (from `state.failures`, permanent only — transient stays
"uploading") that **names the failed files** (via `blobFailed.paths`), and **Retry upload** in the row ⋯
menu (re-issues `deposit` from the row's remembered `srcPath`). A permanent failure is now journal truth
(`Journal.markFilesFailed` → `listFiles` returns `failed` → the ⚠ row survives a refresh/restart). Uploading
rows show a **determinate** progress bar for large solo-blob files (daemon `uploadProgress`), falling back to
the indeterminate stripe for small batched files.

**Remaining UI work, in priority order:**
1. **macOS visual verify** (Ben) — `task ui:demo` / `ui:live`. Electron can't render in the container.
   *(`task ui:demo` archives `testdata`, so the tree shows those `*.bin`; the empty prod vault under
   `ui:live` shows the first-run drop zone until a deposit/source run lands.)*
2. **Remaining daemon contract gaps** (see that section above) to make the rest real — each a source-swap,
   not a rebuild: **exclude get/set**, a per-run **filesFailed** count, **fee + bytes/cost** estimates.
   *(The **`uploadProgress` event** → determinate upload bar, **per-file `failed` status + paths on
   `blobFailed`** → ⚠ row + named files, and **move/rename/delete** (`movePath`/`deletePath`) are now
   DONE ✅ — 2026-06-24/25.)*
3. **Retry depth:** row Retry covers deposits we caught up front (we hold `srcPath`). A real upload that
   fails *after* the daemon accepts it (a `blobFailed`) becomes a journal row with no `srcPath` → retrying
   those needs daemon support (re-deposit by stored path, or a daemon retry command).
4. **Polish:** native folder picker for the Settings **Add-folder** field (`webUtils.getPathForFile` +
   `dialog.showOpenDialog` are already wired for deposit + request-a-copy); `Show in Finder`
   (`shell.showItemInFolder` via IPC); macOS system notification on restore-ready; subset the 5.3 MB
   Material Symbols woff2.

When extending: generic primitives live in `src/renderer/src/ui/` (bound to the vendored token vars in
`styles/tokens/` — the DS SSOT, re-sync don't hand-edit); the browser's domain components + model live in
`src/renderer/src/views/files/`. **Pull current docs via the Context7 MCP** before deep React/Vite/Electron
work.
