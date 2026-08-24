# ColdStorage UI — design & decisions in force

> Moved from the root `ELECTRON-UI-DESIGN.md` (2026-07-02) and trimmed to what's in force. The daemon
> (`coldstored`) is the whole backend — the UI is a **thin client over its control socket**. Orientation:
> [`../README.md`](../README.md) · daemon design: [`../coldstorage/DESIGN.md`](../coldstorage/DESIGN.md) ·
> package/dev docs: [`README.md`](./README.md) · packaged-app state: [`PACKAGING.md`](./PACKAGING.md).

## What the UI is
A control panel for `coldstored`: browse your files, drop files in to upload, reorganize, watch live
progress, and request files back. It holds **no upload/restore logic** — the Swift daemon owns
scan/encrypt/upload/restore/journal. The UI reads state and sends commands.

> **UI work is design-led — "it compiles and renders" is not done.** The product's job is emotional
> ("I'll never lose these"), so feel and polish are the product, not decoration. Bind to the vendored DS
> tokens (`src/renderer/src/styles/tokens/`, SSOT) rather than one-off values, and treat a visual change as
> unfinished until it has been *looked at* on macOS. Corollary: if you're mid-way through non-UI work and
> tempted to casually restyle something, flag it instead — drive-by UX changes are how a design system
> quietly stops being one.

> **VOICE — plain file-uploader, no reassurance theater (Ben, 2026-06-24).** Don't tell the user their
> files are "safe," don't claim/advertise safety, don't editorialize ("steady", "reassuring"). Plain,
> factual verbs: **upload** (not "archive" as the active verb), **stored** (not "safe"), **frozen**
> (factual: deep storage is slow to open). Status is *information*, not comfort — neither alarm nor
> reassurance, just facts.
>
> **Getting files back is a "download" (Ben, 2026-07-27).** The page is **Downloads**, one row per
> REQUEST (ask for a folder of 300, get one row — see the grouping note in the flow below), and a row's
> states are **pending → downloading → done**. This supersedes both prior rulings — 2026-06-24's
> "not 'download'" and the "Transfers" era that followed — because *transfer*, *copy* and *request* had
> each been the entity's name somewhere, which confused even us. The vocabulary now: **download** is the
> entity (the thing that is one row); **request** is the act that starts one ("Request a download…" —
> *request* still carries the not-instant signal the 2026-06-24 rule wanted); **thaw** lives in the
> explanatory copy where it's honest ("deep storage is waking this up"); **transfer** is retired from
> user-facing text. "Downloading" is EARNED, never assumed: for the ~48h thaw the row is **pending**
> (nothing moves — a countdown, no bar); it says **downloading** only while bytes actually land (a
> measured bar); then **done**. The wire keeps its own engineering names for the same lifecycle —
> `restore`, states `pending`/`transferring`/`saved` (`Models.swift` is that SSOT) — and the page's
> STATE map is the single wire→copy translation point.

## The mental model — a reorganizable filesystem (canonical since 2026-06-24)
Two jobs are the whole product: **get files up** and **get them back**. The app does them as a
**drive you browse like a filesystem** — not a dashboard, not a sync-status panel.

- **Front door = the file browser itself.** No home dashboard; status is **ambient** (per-file badges
  + a plain storage line), never a separate screen of counts. A **folder** carries *two* badges, because
  it is not one file: what it **is** (✓ stored / saved-here, or a ⚠ that won't clear on its own) in
  front, and any self-resolving work happening to **part** of it stacked behind it — same size,
  overlapping, each cut out of the row's paint, the way avatars stack on a multiplayer app. Order
  carries the emphasis, and the count rides in the label ("1 of 40 files — waiting on deep storage"). One badge could only tell half the story, and it told the wrong half: a single file thawing
  inside 40 stored photos painted the whole folder amber, which reads as "this is all coming down"
  (2026-08-24). See `rollupBadges` in `views/files/model.ts` for the precedence.
- **Ad-hoc deposit is the hero**, auto-watch is secondary: drop-to-upload is the front door; watched
  folders demote to Settings.
- **It's a real, reorganizable filesystem.** Move/rename/nest/new-folder/delete all work, cheaply and
  honestly, because **the user's tree lives in the journal, not in S3 keys** — a move is a
  `relativePath` edit; the encrypted blob never moves, nothing thaws, nothing re-uploads. (The naive
  path==S3-key model is genuinely broken on Glacier — you can't `CopyObject` a Deep-Archive object
  without a 12–48h restore. Verified vs AWS docs.)
- **The one honest limit:** Deep Archive freezes *bytes*, never *metadata*. You browse instantly,
  always (from the journal) — the multi-hour thaw appears only when you ask for a file's *contents*.
  The UI's job at that moment is to make a long wait feel calm and certain.

## Surfaces — two, not four
*(The original 4-tab Vault/Sources/Restore/Browse layout is superseded and deleted.)*
- **My Files** — the entire drive: browse, drop-to-upload, reorganize, request a download.
- **Settings** — one door, two subpages (tabs): **General** (this-Mac behavior) and **Account**
  (identity/plan — configured installs only; the sidebar identity chip's popover deep-links here).

Sidebar is resizable; no docked detail panel — the per-row `⋯` (and right-click) opens actions,
**Get info** opens a modal.

### Sidebar foot + account chip (2026-07-27)
- **The plan badge hangs off the avatar, not the name line.** The chip was avatar · name · badge ·
  caret on one row with the meter beneath, inside a rail that's 232px by default and draggable down to
  200 — at that width the name truncated to almost nothing. The badge now sits on the avatar's bottom
  edge (the notification-dot placement), short form only (`Free` · `1 TB` · `Active` · `Ends`), and the
  popover says the long form (`Ends Aug 3`) where there's room. Same suppression rule as before: no badge
  when the meter already names the quota.
- **Upgrade has two doors, both free-accounts-only.** A primary button pinned in the sidebar foot, and
  the first item in the account popover. Before this, buying more room meant finding it inside Settings.
  Both open the same `SubscribeModal` with `reason: "upgrade"`. **Neither renders once
  `entitlement.active`** — there's nothing to sell to someone who already bought, and changing an
  existing plan is a priced, prorated decision that belongs on Settings › Account beside its preview.

### Toasts (`ui/toast.tsx`, 2026-07-27)
One `ToastProvider` wrapping the app (outside `App`, so a toast survives its early-return gates), a
`useToast()` channel, and a bottom-center stack. It replaced a single fixed div in `App` that could only
ever say what went **wrong** — so every failure announced itself and every success was silent. Starting a
download answered a click with nothing at all; you went and checked the Downloads page to find out whether
it had worked.
- **Successes expire (~6s), errors wait to be dismissed.** A confirmation is done in a few seconds; a
  failure may need reading twice.
- **They stack, and identical messages collapse** — the daemon re-reports the same live error, and the
  same completion can arrive twice across a reconnect.
- **Errors keep their old shape**: red surface, optional inline recovery action (the Photos-grant one),
  close button.
- Currently fires on: any `exec` rejection · the daemon's live `error` channel · a failed retrieval
  payment (which used to write into a dialog that had already closed, so it went nowhere) · a started
  download, with a **See downloads** action · a completed download, with **Show in Finder**.
- **Not** for uploads. Deposits have their own ambient surfaces (the progress banner, per-row badges, the
  stuck-uploads pill) and the daemon auto-runs on a timer — toasting those would be noise. The pill is
  still the right call for stuck uploads specifically: a one-shot toast gets missed.

```
┌────────────┬────────────────────────────────────────────────────────┐
│ ❄ coldstor.│  My Files › Photos › 2019              ⊞ ⊟    ⊕ Add      │
│            │  Name                          Size      Date            │
│  My Files  │  📁 January                    1.2 GB    12 items        │
│ Downloads 1│  📄 beach.jpg                  4.1 MB    Jul 12 2019  ✓ ⋯ │
│  Settings  │  📄 sunset.jpg                 3.8 MB    Jul 12 2019  ⧗ ⋯ │
│            │  📄 hike.mov                   2.3 GB    Aug 3 2019      │
│ 12 GB      │                                                          │
│            │ ────── drop anywhere to upload · right-click for more ─│
└────────────┴────────────────────────────────────────────────────────┘
   ⋯ → Get info · Rename · Move to… · New folder · Request a download… · Delete
```

## My Files — the browser
- **Navigation:** drill-in + breadcrumbs (like iOS Files / Explorer — scales to an 8,000-photo folder
  where an inline tree would choke). **View:** list by default (name/size/date — no status column),
  grid/gallery toggle (file-type icons today; thumbnails are the only R2-gated piece).
- **Status is a small colored icon by the row's `⋯`**, not a column or text pill (fixed-width slot):
  quiet green ✓ **stored** (explicit success is what makes silence trustworthy — stored must be
  distinguishable from stuck) · blue ↑ **uploading** (a transient retry stays here; it self-heals) ·
  muted-red ⚠ **couldn't upload** (permanent/stuck — also persistent in the sidebar → failures panel
  + Try again / Dismiss, because a one-shot toast gets missed; the pill clears itself when a retry
  lands, Dismiss is acknowledge-only — rows keep their ⚠, and a re-hit fault re-surfaces it) ·
  amber ⧗ **waiting on deep storage** (the thaw — nothing is moving yet) · blue ↓ **Downloading**
  (bytes actually moving) · green `download_done`
  **saved on this Mac**. No icon = nothing in flight.
- **Selection is just selection** (cmd/shift multi → batch ops); details live behind `⋯`/right-click;
  double-click a file = Get info, a folder = drill in. No docked side-inspector.
- **Getting files back is a SECONDARY action, never a promoted CTA** — in the row menu + Get-info
  modal, labeled **"Request a download…"** (*request* signals not-instant); the dialog's confirm is
  **"Start download"** and owns the "ready in ~a day" detail.
- **Empty/first-run:** a bounded, clickable drop-zone card (*"Drop files or folders to upload"* + one
  factual line "encrypted on your Mac before upload" + a "Choose files or folders" CTA). Delete-empty-folder
  skips the confirm (no bytes at stake).
- **Manipulation = standard Finder gestures:** rename (press-and-hold the name → inline edit, or the
  menu — NOT double-click, which opens), new folder, drag-to-move (spring-loaded: hold over a
  folder/crumb and it opens under the drag), delete (⌫ → confirm). **Delete =
  instant tombstone**, and it sticks — a rescan can never resurrect it, only an explicit re-deposit.
  Honest copy: *"Space comes back once the bytes pass 180 days in deep storage — right away for anything
  you've had a while"* (Deep Archive minimum-duration; never imply delete-to-save-money). If the target is
  still inside a **watched folder** the confirm asks `pathIsWatched` before opening and offers **"Also stop
  backing this up"** (on by default), which adds the ignore rule in the same call — otherwise the file would
  sit there un-backed-up with nothing saying why. Bytes are reclaimed once every file sharing their blob is
  deleted (daemon tags the object; a lifecycle rule expires it) — invisible here.

## Deposit flow (the hero)
1. **Drop** anywhere (or ⊕ Add) → *"Drop to upload"*; items land in the currently-viewed folder. The ⊕ Add
   button opens a **native open panel that selects any mix of files AND folders, multi-select** (`openFile`
   + `openDirectory` + `multiSelections` — a web `<input>` can't offer folders at all, which is why the
   deposit picker is native, not an `<input>`). A chosen folder is walked by the daemon and its tree is
   preserved under the current folder. Photos are a separate picker (the Photos library isn't the filesystem).
2. **Encrypt + upload** — daemon-owned, non-blocking: browse/close the app, it continues. The
   **deposit banner** (`DepositProgress`) at the top of the browser is the aggregate: a determinate bar
   driven by the daemon's `runProgress` (bytes uploaded / total across every file and blob), the file
   currently uploading, files done / total, throughput, and a rough ETA — all derived from the
   `runProgress` stream, so a deposit of many small BATCHED files shows real motion instead of silence
   then a burst of green. Before the first ciphertext part lands (bytes still 0) it reads **"Preparing…"**
   over an indeterminate sheen, not a dead `0 B` bar; the ETA shows in **coarse buckets** ("under a
   minute", "about 5 min left") because a fresh estimate only arrives per 64 MiB part, so exact seconds
   would only lurch. A Photos deposit (sizes unknown until streamed → `bytesTotal` 0) falls back to count
   progress + an indeterminate sheen rather than a fake byte bar. Individual uploading **rows** carry only
   a small **spinner** beside the status icon — a quiet "this one's in flight" cue; the quantitative
   progress lives once, in the banner, so the row never repeats it. (The daemon still emits a determinate
   per-file `uploadProgress` for large solo-blob files and the store still folds it, but nothing renders it
   today — retained as a latent capability, e.g. a per-file detail view; see the RETAINED note in
   `state/reducer.ts` / `views/files/model.ts`.)
3. **Done = quiet inline confirmation** (no celebration): *"240 photos uploaded. Skipped 1,203 files
   in node_modules and caches. see what →"*. The skip line is cost-protection made factual — name the
   junk, no salesy "saved you $X," no "safe." *(Needs skipped-count reporting — still open, below.)*
4. **Edge states reflect the proven daemon honestly:** interrupted → resumes the same `uploadId`; a
   blob fails → run continues, failure surfaced named (permanent vs transient); offline → queues.
5. **Name collisions are Finder-style, never silent:** dropping into a *new* folder copies (photos are
   path-keyed, `id == relativePath` — same photo in two folders is two copies, not a silent move).
   Existing names PROMPT (`CollisionModal`): per-file **Keep Both** (`name 2.ext`) / **Replace** /
   **Skip** + apply-to-all, defaulting to Keep Both. Mechanics: `previewDeposit` (no-upload dry-run via
   the real source, so picked-photo names resolve) → modal → `deposit`/`depositPhotos` with a
   `conflicts` map the daemon's `CollisionResolvingSource` applies authoritatively. Copies re-upload
   bytes (content-addressed dedup is a deferred, UX-invisible optimization).
6. **A drop is never silent, from the instant it lands:** `previewDeposit` recursively stats everything
   dropped, which on a big folder takes real time — so the drop draws a *Reading "X"…* banner
   (`DepositProgress`) immediately, and it sits alongside (never replaces) a run already uploading. The
   two ways that walk can come back with nothing are told apart and both surface: a preview that FAILS
   is an error, and a preview that returns EMPTY (unreadable path, or everything excluded) is an error
   naming what was dropped. Neither may pass as a successful no-op — that combination is what made a
   30 GB folder drop look like the app had ignored it (2026-08-24).

## Request-a-download flow (available, not advertised)
1. Trigger from the row `⋯` / Get-info modal; works on one file, a multi-select, or a folder.
2. **Confirm = explicit modal** (paid + multi-hour → never accidental), button **"Start download"**:
   file · size · **ready in ~a day (up to 48h)** · **cost ~$X** · a "Save to" row with the native
   folder picker (defaults to Downloads, chosen per request — no global setting) · "you can close the
   app — we'll fetch it and let you know."
3. **In-flight = named stages, and a bar only where one is MEASURED** (Deep Archive reports only warming
   vs ready): **Preparing** (~12–48h, the honest unknown) → **Downloading** → **Ready**, with a quoted
   ready-by time.
   **The wait counts down (2026-07-27).** A named stage says what's happening but not where you are in
   it, and "how much longer" is the question the page is opened to answer. The daemon sends
   `typicalWaitSeconds` beside the prose `typicalWait` — the tier holds the NUMBER once and derives the
   prose from it, so they can't disagree, and the renderer never parses copy for a number — and a
   `pending` row shows
   `requestedAt + typicalWaitSeconds - now` as *"About 1 day 17 hours left."* It's AWS's typical case, not
   a deadline: past it the row reads *"Taking longer than the usual ~48 hours. Still waiting."* rather
   than a clock at zero.
   **…and that reassurance now has a ceiling (2026-08-21).** "Still waiting" had no upper bound and the row
   had no freshness: `requestedAt` was its only clock, so a transfer nothing had checked on in a month
   rendered identically to a healthy 48-hour wait — the page narrating work that wasn't happening, which is
   exactly what a `pending` state must never do. The daemon now stamps `lastStepAt` on every active row
   every pass, **whatever the outcome** (`restorePass`; a freshness clock that only ticks on success goes
   quiet precisely when it matters), and publishes `restoresChanged` on every pass rather than only on
   state news — "we checked, still warming" *is* the news. A `pending` row therefore reads one of three
   ways: counting down; over the estimate but actively watched ("Still waiting"); or **stalled** — nothing
   has checked within the daemon's own `staleAfterSeconds`, or it has run past 2× the estimate while we
   *were* checking. A stalled row goes red, swaps its clock icon for a warning, says when we last actually
   looked, and grows the same **"Ask again"** the unpaid state has — a row that admits it's stuck while
   offering only "Stop" is a dead end.
   The staleness threshold comes **from the daemon** — `Status.staleAfterSeconds`, derived from the run
   loop's real beat (`RestoreRow.staleAfter`; `COLDSTORE_INTERVAL` makes it configurable) — for the same
   reason `typicalWait` does: only the party that sets the cadence can say what a suspicious silence looks
   like. The renderer briefly kept its own "a day", which was right for the default beat and silently wrong
   for any other. It rode on each restore row before landing on the snapshot, which read fine until the file
   tree needed the same number and there was no restore row to take it from. `Infinity` when no snapshot has
   arrived: with no idea how often the daemon promised to look, silence proves nothing.
   The verdict itself is `restoreStall` in `daemon/protocol.ts`, next to `isActiveRestore`, because **two
   surfaces answer to it**: this page's copy/button, and the My Files status overlay — which no longer
   paints a stalled *or* unpaid download as "Waiting on deep storage". A file whose download isn't moving
   reads as what it is, safely stored; the thing needing action lives on Downloads, which says it plainly.

### Uploads got the same treatment (2026-08-21)
The tree renders a journal `planned` file as **"Uploading"**, and that arrow had the older version of the
same problem — no expiry, and no reason. Two of the three ways an upload stops getting anywhere already
wrote journal truth (a permanent fault and an over-quota refusal both `markFilesFailed`, precisely because
a row stuck on "Uploading" forever is a lie). The third — a **transient** fault, the one that repeats —
touched the journal not at all: it went out as a `blobFailed` bus event and nowhere else, so if the app
wasn't open when it fired, no trace of it existed anywhere.

Now: `Journal.recordFileFault` persists the reason **without** flipping status (the file legitimately stays
queued — that is what transient means), `files.lastAttemptAt` stamps every outcome, and both reach the app
on `ListedFile`. A file that isn't getting anywhere resolves to a **`stalled`** status — `sync_problem`,
warning tone, deliberately *not* the `failed` ⚠, because nothing has given up. `uploadStall` names which
kind: `retrying` (a fault is recorded) or `unattended` (silence past the daemon's window).

`files.error` had been sitting in the journal **unread since failures were first persisted** — even a
permanently failed file showed a bare ⚠ that couldn't say why. It's now on the row icon's label and in
Get info.

One asymmetry is deliberate: a null `lastAttemptAt` is **not** a stall, where a null `lastStepAt` is. A
restore row is created by an explicit user request and handed to the loop, so never-stepped means the loop
isn't running on something someone paid for. A `planned` file is created *by* the loop moments before it
attempts the file — null is the ordinary state of a fresh deposit, and flagging it would light up every
drop the instant it appeared.
   **The download itself now has a real bar (2026-07-27).** The engine streams the ranged GET
   frame-by-frame and narrates plaintext bytes as they land (`restoreProgress` events, folded into the
   store's ephemeral `restoreProgress` slice), so a `transferring` row draws a measured determinate bar +
   *"1.2 GB of 50 GB · 42 MB/s · about 20 minutes left"* — the same `throughput`/`etaSeconds` math and the
   same `cs-bar-*` visual as the deposit banner, one mechanism in both directions. Until the first tick
   lands the bar shimmers indeterminate rather than claiming a number; the thaw wait still gets no bar,
   because there nothing is measured.
   The phrase itself is `ui/duration.ts`'s `timeLeft`, **shared with the deposit banner** — "how much
   longer" is one question, and it briefly had two formatters with two voices ("about 5 min left" on an
   upload, "About 1 day 17 hours left" on a download). One function, one set of buckets: coarser the
   further out, which suits both a jittery upload rate and an estimate that was never a measurement.
4. **Ready → macOS system notification** (walk-away is the whole design): *"wedding.mov is ready — in
   your Downloads folder [Show] [Open]."* *(Notification still open, below.)*
5. The local copy expires after the requested `days`, then re-freezes → honest *"available until
   Jun 28,"* download-again is one click.
6. A count on the **Downloads** nav item (above Settings) — the page is the detail, so the badge has
   somewhere to go. Downloads are journal rows the daemon drives, so they survive sign-out, relaunch and
   a closed app. (Superseded the sidebar-foot pill + its popover, 2026-07-27.) The badge counts
   REQUESTS, not files — the same fold the page shows.
7. Batch/folder request → one **combined** quote (`240 files · ~a day · ~$3.10`) — **and one row
   (2026-07-27)**. The Downloads page folds the daemon's per-file rows into one row per request
   (`views/downloads/model.ts`): `jobId` is the group key (it IS the quote — everything bought together
   shows together; null jobIds never merge), the label is the files' shared vault folder ("Photos"),
   the headline state has a stated precedence (unpaid > downloading > pending > failed > stopped >
   done), the countdown speaks for the slowest pending file, and the bar is bytes-landed over the
   request's total. Expanding shows the per-file rows; every action fans out to the per-file daemon
   commands. The journal and wire STAY per-file — that's what keeps stop/resume/partial failure honest
   underneath.
8. **A folder comes back as a folder (2026-07-27).** Every file used to save as
   `<chosen folder>/<basename>`, so requesting `Photos` back dumped 300 loose files into Downloads and
   any two sharing a name in different subfolders overwrote each other. The destination now strips
   `restoreBase(targets)` — the deepest folder containing everything asked for — and keeps the rest of the
   vault path, which is Finder's own rule: ask for a folder and you get the folder, ask for files and you
   get the files. `restoreBase` reads that off the TARGETS, not the expanded file list, because requesting
   `Photos` and requesting every file inside it expand identically and must land differently. The daemon
   creates the intermediate directories on its way to writing each file.

## Settings
**One door, two subpages (2026-07-17).** The nav has a single Settings entry; inside, a small
text-forward tab strip (`Tabs` primitive, a real `tablist`) splits it into **General** and
**Account**. The cut is the ownership line — *"would this setting follow me to a second Mac?"* —
so every future setting has an unambiguous home: notification prefs → General; recovery code /
device list → a **Security** tab added the day that content exists (never an empty pane as an IOU).
The tab is App-owned state: last-visited is remembered across a trip to My Files, and the sidebar
identity chip's popover deep-links to Settings › Account. **Dogfood mode (unconfigured) shows no
tab strip at all** — General's content IS the page, byte-identical shape either way; the
conditionality is structural, not a card that appears mid-page.

### General — how this Mac backs up
- **Watched folders:** list + "Add a watched folder" + **"Sync now"** (global catch-up). Each row: a
  rounded accent folder tile, source → destination (`~`-shortened Mac path over `↳ My Files / <mount>`),
  a live status badge (🟢 Up to date · 🔵 Syncing… · 🟠 Not watching · 🔴 **Can't reach it** — driven by
  the live `run.active`, not the poll-only `status.running`), and a ghost `⋯` with **Stop/Start watching** (persistent
  per-source pause; the amber badge + dimmed row keep a stopped folder from looking protected) and
  **Remove…** (confirm — uploaded files stay). Watched folders carry a **destination mount**
  (`mountPath`, defaults to the source basename, never root) chosen in the add dialog via the shared
  `FolderTree` drill-in picker; Model A (mirror mount) — watched trees stay daemon-owned/structure-
  preserving, reorg is reserved for manual deposits. Manual deposits are unaffected by pause.
  **A folder we can't read now says so (2026-08-21) — and this was the worst of the three.** `LocalDirSource`
  opened with `guard let en = fm.enumerator(at: root, …) else { return [] }`, so an unmounted drive, a
  deleted folder or a revoked permission produced an EMPTY list — indistinguishable from "nothing new."
  The run completed cleanly, `runFinished` fired, and this row rendered a green **Up to date** every five
  minutes for a backup that had stopped. The walk now throws `sourceUnreadable` naming *which* problem it
  is (gone vs. unreadable — plug the drive in vs. grant access are different fixes), the daemon records it
  per-source (`sources.lastScanAt` + `sources.error`, stamped every pass either way), and the row shows a
  red **Can't reach it** with the daemon's own words underneath.
  The two halves had to land together: `MultiSource` stops at the first throw, so an honest walk ALONE
  would have turned a silent partial failure into a loud total one — one unplugged drive halting every
  other folder. `ScanReportingSource` records each folder's outcome and isolates its failure, which is what
  makes returning `[]` after a fault a different act from returning `[]` in silence.
- **Don't back up (excludes):** friendly removable chips over real gitignore-style globs, seeded with
  smart defaults; daemon is the SSOT (journal-persisted, applied *inside* the directory walk so junk
  is never hashed and node_modules is pruned whole). Matching is case-insensitive, like the filesystem —
  before that, the seeded `caches` could never fire, because macOS spells it `Library/Caches`.
  Per-source extras are a later refinement.
- **Suggested skips (2026-08-24):** the junk that's junk only *in context* — build output, VM disks,
  installers, photo libraries — can't be seeded, because a developer's `build/` regenerates in seconds and
  a woodworker's `build/` is photographs of a workbench. So it's **offered**, from one catalogue
  (`ExcludeSuggestion.all`) reached two ways:
  1. a **Suggested skips** dialog off the "Don't back up" card header (its trigger carries the count of
     packs currently on), with every pattern visible inside and both gestures — turning a pack on, and
     turning it back off, since "undo" can't mean seventeen chip removals. It's behind a dialog for its
     LENGTH, not to hide it: the chips that are actually in force stay on the page, which is the rule that
     matters — what isn't being backed up is never folded away, what we merely recommend can be;
  2. a **drop-time prompt**, which is the one that earns its keep. `previewDeposit` already walks the
     dropped folder, so it tags each item with the pack that *would* have caught it and the app can say
     "3.2 GB of this is build output" before a byte uploads — the last moment the answer is free, since
     Deep Archive bills a 180-day minimum on everything that lands.
  Three rules hold it honest: a pack's on/off state is **derived** from the excludes list, never stored, so
  nothing can contradict the chips the user edits; a suggestion **tags but never prunes**, so previewing
  with them returns the same files as without (`suggestionsTagButNeverFilter`); and skipping is scoped to
  the one deposit (`excludeExtra`) unless the user ticks **Remember this** — *not this time* and *never
  again* are different answers, and the prompt has no pre-selected path that quietly performs the second.
- **Storage (dogfood mode only):** the quota row stays here because there's no Account subpage to carry
  it. Signed-in installs have no card in this slot. The encryption fact lives in the page footer instead
  (lock + check + "encrypted" — plain, no "safe", no privacy over-claim): it never changes and nothing
  acts on it, so it doesn't earn a card.
- **Preferences (2026-08-24):** how the app *looks* on this Mac, last in General — nothing in it can put
  a file at risk, so it doesn't compete with the cards that can. First entry: **Spacing —
  Comfortable | Compact** (`Segmented` primitive, a real `radiogroup`; arrows move *and* select). It is a
  renderer-only, this-Mac choice (localStorage `cs-density`, like the sidebar width) — it describes this
  screen, not this vault, so it never goes near the account.
  **One lever, no per-component variants:** the choice is a `data-density` attribute on `<html>`, under
  which `styles/app.css` re-declares the spacing scale (`--space-3…12`) and control sizes
  (`--control-*`, `--input-height`, `--topbar-height` — the file row's height *is* `--control-md`, via
  `--cs-row-h`, so that one token closes the gaps down a long list). Every rule in the app already
  spends those vars and never a hand-picked px, so the whole shell tightens together (PILLAR3). The
  compact values are re-declared in the *consumer* layer, not in `styles/tokens/` — the vendored DS scale
  stays the SSOT and its comfortable default. They're whole pixels (what actually keeps hairlines crisp;
  a fractional scale factor is what softens them), which frees the ladder to use half-steps and compress
  hardest at the top, where the rungs are just air between blocks: 48→28, 32→20, 24→16, while `--space-1`
  holds at 4px and `--space-3` stops at 8px — the most-used step, and the one carrying row padding. `main.tsx` applies the stored value before React's first paint, so the app never
  renders comfortable and snaps compact a frame later.

### Account — who's signed in, what they pay for (configured installs only)
- **Account card:** Name (inline edit) + Signed in as, with **Sign out** as the header action.
- **Plan & billing panel** (`views/BillingPanel.tsx`) — **a state, not a list of fields.** A tinted
  status strip on top with ONE sentence and ONE primary action, switched exhaustively over
  `BillingState` (`renderer/src/state/billing.ts`): Active · renews · amount → Change plan · Ends
  *date* → **Keep my plan** (un-cancel) · Payment failed → Update card · Paused → Resume · Free →
  Upgrade · Finishing checkout · **Couldn't load your billing details → Try again**. Under it two
  columns — *Your plan* (badge, quota meter, the row below) and *Payments* (card on file, next
  charge amount + date, one link into Paddle's portal for invoices/receipts/tax details, and a quiet
  Cancel).
  **Why a state machine:** the old card was rows each gated on `subscription != null`, and the
  renderer caught fetch failures into `null` — so a failed read rendered as a free account: green
  "Active" badge (from the separate cached entitlement flag) above a card with no plan, no price and
  no way to cancel. A field that fails to load vanishes; a state always has a branch. Failure is now
  a first-class state carrying the server's own message (PILLAR5).
- **The quota row — ONE row, one number:** *"In deep storage — 12 GB of 25 GB"* (the `of Y` appears
  once the plan's quota is known, from the backend's entitlement). The bytes are
  `getStatus.bytesStored`: a **live S3 listing** under the user's own prefix, so it counts every
  device they've deposited from and it is the exact figure the quota is enforced against. It lives
  beside its remedy (Change plan); the sidebar chip's meter is the ambient copy.

  It used to be two rows — a journal-summed "In deep storage" beside an S3-derived "Plan usage" — which is
  a per-device number and a per-identity number sitting next to each other, both labelled as the truth about
  the vault. They can legitimately disagree for a multi-device user, and when the 2026-07-13 cross-account
  leak inflated the journal sum with a second account's files, the two rows disagreeing was the first
  visible symptom. Don't reintroduce a second storage total. (Selection sizes elsewhere — the request-a-copy
  dialog, My Files — still sum file rows; that's a different question, about *these files*, not *the vault*.)
- **No "download location" setting** — destination is chosen per request in the dialog.

### The page foot — which build, and is it current (`views/VersionFooter.tsx`)
Below the cards on **both** tabs, quiet and rule-separated: `coldstorage <version>` (from main's
`app.getVersion()` — the packaged `package.json`, never a string typed into the renderer), the Electron
version, and a `development build` marker when unpackaged. Beside it, the auto-updater's live state and a
**Check for updates** button (a **Restart to update** button instead once a build is `ready`).

This is the only place the updater is visible when it isn't interrupting: `UpdateBanner` shows at `ready`
alone, which left checking, downloading and — the expensive one — *failing* completely silent. So the
footer names the error in the updater's own words. It also needs `UpdateStatus.lastCheckedAt`: without a
stamp, a manual check that finds nothing lands back on `idle` and reads as a button that did nothing, and
"nothing newer as of 3:42pm" is indistinguishable from "we have never had an answer". A dev build says
auto-update is off rather than offering a check that can never succeed. Wording is tested
(`VersionFooter.test.ts`), not eyeballed.

Two fields, not one, decide whether a check is worth offering: `AppInfo.packaged` **and**
`AppInfo.signature` (`main/updater/signature.ts` — a memoized `codesign` read). A build that isn't
Developer ID signed passes every check and download and is then refused at install by Squirrel.Mac, so
"Up to date" would be the most misleading sentence on the page; the footer names the install instead.
That case is not hypothetical — it cost a month of silent non-updates before the footer could say it.

## Onboarding — the first-run wizard (2026-07-16)
After sign-up, one wizard in the same `.cs-signin` gate-card frame, progress dots on top, one idea
per screen: **name → tour ×3 → recovery code → 2 skippable questions → done**
(`views/OnboardingWizard.tsx`; gated in `App.tsx` between `RecoveryCodeEnter` and the vault gates).

- **Name** — shown on BOTH lanes; Google arrives prefilled from the ID token's `name` claim (the
  `cognito.tf` attribute mapping). The durable name is the backend's `displayName` column, NOT the
  Cognito attribute — Cognito re-applies the Google mapping at every federated sign-in, which would
  clobber an in-app edit. Required, no skip; a FAILED save offers "continue without saving" (fail
  open — the name is cosmetic; it stays editable in Settings and re-asks next launch).
- **Tour** — the three load-bearing expectations, in plain uploader voice: deep archive = cheap to
  keep / hours-not-seconds to bring back (+ big restores priced upfront); explicit ingest (nothing
  auto-uploads, originals stay); zero-knowledge ("Your data is only ever visible to you"), which
  sets up the very next screen. Not skippable — three clicks, no timers.
- **Recovery code** — the existing `RecoveryCodeShow`, now with dots + a recorded
  `recoveryCodeConfirmed` fact. If the fact is missing but the vault is unlocked (app died
  mid-signup), the app **reissues** a fresh code (daemon `reissueRecoveryCode` wraps the LIVE MK;
  the new key-blob is PUT server-side BEFORE the code is shown, so a shown code always works and
  the old one is dead).
- **Questions** — data collection, honestly labeled optional: "What are you keeping cold?"
  (multi-select) + "How did you find ColdStorage?" (single). Full-width option ROWS, not centered
  chips (long labels wrap raggedly). Answers → `survey` jsonb as option IDS (catalog mirrored from
  `account-backend/src/survey.ts`); Skip records nothing, and nothing ever re-asks after the wizard.
- **Done** — names the free tier from the backend's `quotaBytes` (never hardcoded) and lands on the
  empty-vault drop zone.

**Resume rules (derive, don't record):** every step's done-ness is a server-side fact on
`accountsTable` — `displayName`, `onboardedAt`, `recoveryCodeConfirmedAt` (+ key-blob existence for
the vault). The step LIST is frozen at wizard mount from those facts; only the index is local. An
interrupted run resumes with exactly the steps still owed; `onboardedAt` is per-ACCOUNT, so a second
device gets recovery-code entry, never a tour re-run. The wizard fails OPEN when `GET /account`
hasn't landed (`known: false`) — the plain vault gates carry the session.

**Terms are sign-in-wrap**, not a wizard step: the agreement line lives under the sign-in card's
actions, and continuing IS acceptance — recorded by the main-process `AccountManager` as
`termsVersion` + `termsAcceptedAt` whenever the stored version is absent/stale (versioned so a
material change can gate a re-agree later). Deliberately NOT in the wizard: notification permission,
Photos access (asked contextually when first relevant), any plan pitch (the free tier covers day one).

## The one architectural decision (don't re-litigate)
**Electron's main process speaks the daemon's JSONL protocol directly over the unix socket** — a Node
`net.Socket` to `COLDSTORE_SOCKET`. **Not** by spawning `coldstorectl`, **not** via a Swift/native
bridge. The control protocol is already the client contract; the renderer never touches the socket —
it talks to main over Electron IPC (`contextIsolation` + `contextBridge` → `window.coldstore`).

## The contract (SSOT — do not duplicate, bind to these)
- **Wire shape:** `coldstorage/Sources/ColdStorageCore/ControlProtocol.swift` — one request per line
  (`{id, method, params?}`); replies carry `id`; pushed events carry `event`. `ui/src/daemon/protocol.ts`
  is the hand-kept TS mirror.
- **Commands (SSOT = `DaemonService.handle`):** `ping · getStatus · listSources · listFiles ·
  listExcludes · addSource · removeSource · addExclude · removeExclude · restorePlan · requestRestore ·
  listRestores · cancelRestore · resumeRestore · forgetRestore ·
  deposit · depositPhotos · previewDeposit · movePath · createFolder · deletePath · pathIsWatched · authenticate ·
  deauthenticate · mintVault · unlockVault · unlockVaultWithRecoveryCode · lockVault · triggerNow ·
  pauseSource · resumeSource`. (`authenticate`/`deauthenticate` = the **session** opened/closed —
  per-user S3 creds plus the user's journal, staging dir and key holder; the `*Vault*` four = the
  zero-knowledge encryption key, loaded/cleared over the local socket — all multi-user only.)
- **Session lifecycle — the daemon serves ONE user, or none.** `authenticate` builds the session
  (`UserSession`), `deauthenticate` destroys it; a different Cognito `sub` tears the old one down first.
  **Signed out, the daemon serves nothing:** `getStatus`/`listFiles`/`listSources`/`listExcludes` return
  the empty answer, everything else errors *"not signed in"*. `getStatus` now carries **`signedIn:
  boolean`** (and `bytesStored: number | null` — non-null whenever signed in). The renderer must NOT
  keep rendering the previous account's tree: `authChanged` resets every vault-derived slice
  (files/status/excludes/run/failures/restores) on sign-out **and** on an account switch, keyed on the
  account — the daemon's isolation is only half the fix if the UI still holds the last user's state.
  **Clearing is only half of THAT fix:** every cleared slice must be refillable from the daemon on the way
  back in. `restores` was cleared but had no daemon read behind it, so signing out and back in destroyed
  an in-flight download permanently (Ben, 2026-07-27) — the file just showed a green ✓ again. `beginSession`
  publishes `filesChanged`, and the controller re-reads status/files/excludes/**restores** on it.
- **Events (SSOT = the `DaemonEvent(...)` call sites):** `runStarted · fileArchived · uploadProgress ·
  runProgress · runFinished · blobFailed · sourcesChanged · filesChanged · excludesChanged ·
  restoresChanged · restoreProgress · restoreCompleted · error`.
  `restoreProgress` carries `{id, file, bytes, totalBytes}` — plaintext bytes landed for ONE transferring
  row, per ~4 MiB frame; folded into the store's ephemeral per-row slice for the Downloads page's bar,
  never a source of row state.
  `runProgress` carries `{filesTotal, bytesTotal, filesArchived, bytesUploaded, currentPath}` — the
  whole-run aggregate the deposit banner draws from (all ENCRYPTED bytes; `bytesTotal` 0 ⇒ unknown, e.g.
  Photos; ETA/throughput are derived UI-side, never sent — coarsely, in buckets, since a snapshot only
  lands per 64 MiB part). `uploadProgress` carries `{file, path, bytes, totalBytes}` — a determinate
  per-file signal for large solo-blob files, still emitted and folded into the store but no longer rendered
  (uploading rows now show a plain spinner); retained as a latent capability; `blobFailed` carries `{blob, kind, message, paths}` (newline-joined
  relativePaths); `filesChanged` carries `{moved, to}` / `{created}` / `{deleted}` — the cue to re-read
  `listFiles` — plus `{signedIn}` / `{signedOut}`, the cue that the tree just changed owner entirely.
- **Connection model:** one long-lived socket for the event tail (blocks indefinitely by design) +
  bounded request/response for commands (a `readTimeout` so a stalled daemon fails fast); match
  replies by `id`, events interleave. Auto-reconnect covers launchd KeepAlive restarts.

## Where the code lives (all built, tests green)
- `ui/src/daemon/{protocol,client}.ts` — typed `DaemonClient` over the socket (layer 1; `task ui:prove`).
- `ui/src/main/` — owns the one `DaemonClient` + native seams (`system.ts`: pickers, photo-picker
  spawn; `daemon.ts`: the packaged-app daemon supervisor — see `PACKAGING.md`); `src/shared/ipc.ts` is
  the typed main↔renderer seam; `src/renderer/src/state/` is reducer (pure fold) → store
  (`useSyncExternalStore`) → controller (layer 2; `task ui:test`).
- `ui/src/renderer/src/ui/` — the shell's own primitives, no product logic: `primitives.tsx` (Button,
  Badge, Modal, Icon, Skeleton…), `layout.tsx` (Sidebar + Page), `useResizable.ts`, `toast.tsx`
  (the app-wide `ToastProvider`/`useToast` channel — see "Toasts" above), and `duration.ts`
  (`timeLeft` — the one "how much longer" phrase, shared by the deposit banner and the thaw countdown).
- `ui/src/main/auth/` — sign-in, two lanes into ONE token lifecycle: Google via
  Cognito managed-login OAuth (`oauth.ts` — PKCE, system browser, `coldstorage://auth/callback` deep
  link packaged / loopback in dev) and email one-time-code via the Cognito API as plain HTTPS JSON-RPC
  (`cognito-idp.ts` — SignUp/ConfirmSignUp/InitiateAuth/RespondToAuthChallenge, no SDK). `manager.ts`
  holds tokens (access/ID in memory, refresh token safeStorage-encrypted), is **lane-aware** (each
  session tagged `oauth`|`email`, refreshed at its own endpoint), and runs the daemon handoff (fresh ID
  token → `authenticate`). A closed browser tab sends no callback at all, so the pending OAuth attempt
  has two ways out besides success: a user-facing **Cancel** (`auth:cancelSignIn`) and a self-expiry at
  the code's 5-minute TTL — the `signingIn` card is never a dead end. The renderer sees only
  `AuthStatus` over IPC — never a token. Gate UI:
  `views/SignInView.tsx` (Google + the email step machine) + the account card in Settings.
- `ui/src/main/vault/` — the zero-knowledge vault: the encryption-key half of being
  signed in. `manager.ts` decides per-device — cached MK → `unlockVault`; new account → `mintVault` +
  store the key-blob + show the recovery code once; new device → prompt + `unlockVaultWithRecoveryCode`.
  `keyblob-client.ts` = blind GET/PUT at the account backend; `storage.ts` = per-account MK escrow in
  safeStorage. Renderer sees only `VaultStatus` (never key material, except the one-time code to show).
  Gate UI: `views/RecoveryCodeView.tsx`. The daemon handoff runs `authenticate` THEN vault `provision`.
- `ui/src/main/entitlement/` — subscription billing: `manager.ts` fetches
  `GET /entitlement`, serves the plan catalog (`getCatalog()` → the backend's live `GET /catalog`),
  and drives `subscribe(priceId)` (POST `/checkout-session` with the chosen plan → open Paddle
  checkout in the system browser → poll until the webhook flips active). Renderer sees only
  `EntitlementStatus` + `CatalogPlan[]`. A gate on DEPOSITS (not browse/restore) — and since the
  free tier landed (PROD.md "Free-tier entitlement flip") **the gate is the byte quota, not the
  subscription**: every signed-in account has a `quotaBytes` (the free tier, or the plan's), and a deposit
  that would OVERFLOW it is refused. **Enforced in TWO places, and the daemon is the one of record:** the
  renderer's `state/entitlement.ts` → `hasCapacityFor(entitlement, usedBytes, incomingBytes)` (pure +
  unit-tested, fails OPEN on any unknown) is fast UX — it shows the paywall before a doomed upload starts;
  but the real ceiling lives in the daemon's `UploadEngine.run(quota:)`, which refuses any blob that would
  cross it. That's what makes it un-bypassable — it covers the periodic auto-run the renderer never sees,
  and a non-UI client can't sidestep it. The app pushes the number down with `setQuota` (on auth + every
  entitlement change); the daemon reports a refusal as `blobFailed` kind `overQuota`, which opens the SAME
  paywall the client gate would have (so the experience is identical whichever layer catches it — this is
  what covers the fail-open path: a drop that slipped the client gate while its inputs were still null, or a
  background auto-run) and surfaces in the "couldn't upload" panel, retrying once there's room. The client check is **size-aware**: `usedBytes` is
  `bytesStored` (the lagging S3 listing) PLUS the bytes of the still-`uploading` optimistic rows (in-flight,
  not yet in S3), and the deposit's own size is weighed too — so neither a single oversized drop nor a burst
  slips past a stored total that hasn't caught up. Photo picks contribute 0 to the client-side size math
  (unknown until the daemon resolves them) — but the daemon enforces them precisely against measured bytes,
  so the ceiling still holds; file drops carry `File.size` and are exact on both sides.
  `entitlement.active` is a DISPLAY signal only: it picks which upsell a full vault shows — a free account
  gets `views/SubscribeModal.tsx` (`reason: "quotaReached"`), a subscriber gets the "Storage full" modal →
  `ChangePlanModal`. The same SubscribeModal opens with `reason: "upgrade"` from Settings when nobody is
  blocked, which is why it takes a `PaywallReason` rather than inferring the moment. It's the multi-plan
  picker (PADDLE.md spec: size cards, fetched live, never hardcoded; the picker itself is the shared
  `views/PlanPicker.tsx`); Settings shows the state. `coldstorage://checkout-complete` is a check-now nudge.
  **The wait is never a dead end:** while `checkingOut` is true the modal offers `reopenCheckout()` (the same
  Paddle transaction reopened — never a second one) and `cancelCheckout()` (stops the poll, clears the wait,
  picker back at once); an abandoned checkout that times out says so instead of silently reverting. **Manage surface (2026-07-10, widened 2026-08-24 — PADDLE.md "Managing a subscription"):**
  `getSubscription()/previewPlanChange()/changePlan()/openManage()/resumeSubscription()` → folded
  ONCE into `BillingState` (`renderer/src/state/billing.ts`), rendered by both the sidebar's pinned
  `views/AccountCard.tsx` (avatar · email · a Drive-style storage meter fed by the gate's own
  used/quota figures; the plan badge hangs off the AVATAR's bottom edge rather than sitting beside the
  name — see "Sidebar account chip" below — and only when the meter can't name the quota; click → a
  popover: identity summary + **Upgrade** on a free account + "Settings…" deep-linking to
  Settings › Account + Sign out)
  + Settings › Account
  (`views/BillingPanel.tsx` + `views/ChangePlanModal.tsx` with a proration preview; invoices, card,
  tax details and cancel open Paddle's customer portal in the browser, one session per click).
  The chip no longer derives its own badge — two copies of that rule had already drifted.
- `src/renderer/src/styles/tokens/` — the 5 DS token CSS files **vendored verbatim** (SSOT — re-sync,
  don't hand-edit) from the coldstorage Design System (Claude Design `41ebafc1`), ported to native
  React 19 TSX (the DS's UMD/CDN runtime isn't consumable in electron-vite). Primitives in
  `src/renderer/src/ui/`; the browser's domain components + pure model in `src/renderer/src/views/files/`
  (headless-tested). Fonts self-hosted (Fontsource + material-symbols) for the locked-down CSP.

## Remaining UI-lane work (still open)
1. **Skipped-count reporting** (daemon): the deposit "skipped 1,203" line needs the run to report how
   many files the excludes filtered. Also a per-run **filesFailed** count (blobs ≠ files).
2. **Retry depth:** row Retry re-issues `deposit` from the remembered `srcPath`; a failure *after* the
   daemon accepted it (journal row, no `srcPath`) needs daemon support to retry.
3. **Polish:** macOS notification on restore-ready (`restoreCompleted` is the hook, still unwired);
   subset the 5.3 MB Material Symbols woff2 to the ~12 glyphs used.
4. `newFolder` is local-only until something lands in it (a virtual path — nothing to persist).
5. **Background-run UX:** a Tray + `LSUIElement` so the always-running app lives in the menu bar,
   plus a Settings toggle for `openAtLogin`.

## Gotchas (save the next agent hours)
- **Browse is NOT R2-blocked — only photo thumbnails + cross-device index portability are.** Deep
  Archive freezes object *bytes*, never *metadata*, and the tree comes from the journal (not
  `ListObjectsV2` — blobs are opaque `blobs/<hash>` objects). Don't block browse work on R2.
- **Socket perms:** `0600`, same user — fine. Dev socket `coldstorage/coldstored.sock`; installed
  `~/Library/Application Support/ColdStorage/coldstored.sock` (`COLDSTORE_SOCKET`).
- **A download is a durable journal row, not a request/response** (a `restore`, on the wire).
  `requestRestore` records it and returns the whole list; the DAEMON's run loop then steps it
  (`restorePass`) until it lands, so it keeps going with the app closed. Read `listRestores` for state;
  never accumulate a copy from events. The old one-shot `restore` command is gone: nothing re-issued it,
  so every download stalled at `thawRequested` forever while the UI showed it as downloading.
- **States are named** — `needsAuthorization | pending | transferring | saved | canceled | failed` — **and
  only measured movement gets a percentage.** Deep Archive reports only warming vs ready, so the thaw wait
  never draws a bar; `transferring` does (2026-07-27), fed by the daemon's per-frame `restoreProgress`
  ticks — a byte counter for the bar only, ephemeral by design. Row STATE still comes exclusively from
  `listRestores`; never grow rows from events.
- **JS tooling is Bun** (repo convention), but Electron's main runs its bundled Node — dev/test on Bun,
  ship on Node, only `node:net`. Add deps with `bun add <pkg>@latest`.
- `node_modules` is platform-native — each OS needs its own `bun install` (the container uses a named
  volume; see [`README.md`](./README.md)).
- **The daemon's state is per-user, under a data ROOT** (`COLDSTORE_DATA_DIR`): journal, staging and
  `status.json` live at `<root>/users/<sub>/`, opened at sign-in. The old per-file env vars
  (`COLDSTORE_JOURNAL`/`_STAGING`/`_STATUS`/`_KEK`) are gone; `main/daemon.ts` passes the root.
  `status.json` is a run summary the daemon writes — the socket is the live source.
- **Pull current docs via Context7** before deep React/Vite/Electron work.
