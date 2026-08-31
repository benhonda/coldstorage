# Pause uploads — a real daemon-level pause primitive

> **Status: SETTLED (slices 1–2 scope), slice 3 still open** · 2026-08-31 · provisional
> Records our thinking as of the date above — NOT a contract. Before acting on anything
> here, confirm it still matches the current goal. When it conflicts with where we're
> actually headed now, the current goal wins: flag the conflict, don't silently obey.

## Goal

Let the user pause uploads and later resume them, without the costs today's cancel-then-rerun
workaround carries: discarded in-flight parts, a full re-read + re-encrypt of each partial blob
on every resume, and a "stop" that un-stops itself on the next scheduler tick. Restores already
have suspend semantics (`cancelRestore`/`resumeRestore`); uploads get their own, shaped for how
uploads actually work.

**Not the goal:** pausing scanning/planning (cheap, leave it running), per-file pause
(ui/DESIGN.md already rules out per-row Stop), or fighting the 14-day multipart-abort window
(surface it, don't fight it — see Limits).

## Semantics `[settled]`

- **One global switch:** `pauseUploads` / `resumeUploads` over the control socket. Global, not
  per-source — per-source pause already exists (`pauseSource`) and means "stop watching"; this
  means "stop spending bandwidth". Two knobs with two meanings, no overlap.
- **Persistent:** survives daemon restart and reboot, stored in the journal (a `settings`-style
  scalar, not a source column). A user who paused before closing the lid is still paused after.
- **Drain, don't kill:** on pause, parts already in flight (≤ `maxPartsInFlight` × 64 MiB)
  finish and are journaled; nothing new is dispatched. Zero transferred bytes are wasted —
  the whole point vs `cancelRun`.
- **Hold, don't fail:** a paused run parks; unfinished files stay in their honest pending state.
  No `.stopped` failure rows, no `runFinished` with `filesStopped` — those mean "you stopped
  it", not "it's waiting on you".
- **Scans stay honest, uploads don't start:** `[settled]` (revised from the draft's every-tick
  scanning) — a paused daemon's next pass scans + plans as usual, then parks before the first
  blob; that parked run holds the run lock, so further ticks skip until resume. The journal
  therefore reflects the scan taken at pause time — fresh enough for "what's owed" (PILLAR5) —
  and resume finishes the parked run, after which normal ticks resume scanning. Revisit only if
  long-pause scan staleness ever bites in practice.
- **Resume = release:** a parked run continues exactly where it held — same blob, same open
  multipart upload, next part number. No re-read, no re-encrypt, no ListParts round-trip for a
  same-process resume. (A resume after a daemon restart goes through the existing crash-safe
  path — ListParts ∩ journal — which is already correct.)
- **Manual deposits:** `[settled]` blocked while paused, with a clear error naming the fix
  (`refuseIfUploadsPaused`) — an override would make "paused" a lie, and a fire-and-forget deposit
  parking silently behind the gate would be invisible work.
- **`cancelRun` stays** with its current meaning (abandon this run's remainder). Pause does not
  replace it.

## Mechanism (daemon)

The hard part — and the first slice — is the hold point inside a live run.

1. **`PauseGate` actor** (ColdStorageCore): `pause()`, `resume()`, `waitIfPaused()` — an
   `AsyncStream`/continuation park, cancellation-safe (a `cancelRun` while parked must still
   cancel promptly: wrap the park in `withTaskCancellationHandler`, same pattern as
   `drainOne`, UploadEngine.swift:770).
2. **One check site, two granularities** `[settled]`:
   - **Between parts** — in `PartShipper.push` right where it backpressures on
     `maxPartsInFlight` (UploadEngine.swift:738): after draining in-flight parts, `await
     gate.waitIfPaused()` before dispatching the next. This is the drain-don't-kill point.
   - **Between blobs** — top of the per-blob loop (UploadEngine.swift:258, next to the
     existing `Task.isCancelled` check).
   Frame-level (4 MiB) checks are unnecessary — a part is the durability unit; holding
   mid-part buys nothing and complicates the shipper.
3. **Scheduler loop** (`runForever`): a paused pass scans, plans, then parks inside the run (see
   the semantics bullet above); the loop sits captive on that parked run, which is fine — its
   ticks would have been `skipIfBusy` skips anyway. What made this safe: restores moved to their
   OWN beat (a child task in `runForever`), because sharing the upload loop's turn meant a parked
   run stalled `restorePass` indefinitely — pausing uploads must never stall a paid-for restore.
4. **Persistence:** `[settled]` a `settings` key/value table in the journal (`uploadsPaused`,
   self-migrating like every other journal schema change), read at **session start** — not daemon
   start — to seed the gate: the journal is per-user, which is exactly what keeps pause state from
   leaking across accounts. Sign-out with a parked run cancels it (`.stopped`, resumable next
   sign-in) so no zombie holds the run lock.

## Protocol + UI

- `[settled]` Two verbs in the command table (DaemonService.swift dispatch + ui/src/daemon/protocol.ts):
  `pauseUploads` / `resumeUploads` → `Ack`, plus a dedicated `uploadsPausedChanged` event.
- Paused state is readable on connect: `getStatus.uploadsPaused` — a freshly launched app renders
  "Paused" cold (PILLAR5). The renderer folds `uploadsPausedChanged` into that same snapshot slice.
- UI: a global Pause/Resume control + a persistent "Uploads paused" banner state; while a run
  is parked, the progress row shows paused, not stalled. Copy written properly at build time.
- `coldstorectl` needs nothing — it's a generic passthrough.

## Limits — surfaced, not fought `[settled]`

- **14-day multipart abort** (bucket lifecycle, infra/coldstorage): a blob paused mid-flight
  for >14 days loses its landed parts and starts over. The engine already survives this
  (UploadEngine.swift:392-400). UI surfaces it if pause age approaches the window — a quiet
  nudge, not an alarm. `[open]` whether v1 nudges at all or just documents it.
- **Content drift**: a file edited during a long pause fails `contentDrift` on resume and
  re-plans under a new blob id — existing, correct behavior; pause just makes it likelier.
  No change.
- **Deep Archive staging cost**: incomplete parts bill at Standard rates until Complete
  (coldstorage/DESIGN.md:229-231). Long pauses cost pennies; not worth UI.

## Phasing — hardest first

1. **Steel thread** (landed 2026-08-31 — SSOT is the code: `PauseGate.swift`, the two
   `waitIfPaused` sites in `UploadEngine.swift`, `pauseUploads`/`resumeUploads` in
   `DaemonService.swift`, `Journal.uploadsPaused`, `PauseUploadsTests.swift`): pause mid-blob
   holds after the in-flight parts drain, resume re-sends zero bytes (proven via
   `uploadPartCalls`), the flag round-trips through the journal, cancel-while-parked stops
   promptly as `.stopped`.
2. **UI** (landed 2026-08-31 — SSOT is the code: `PausedBanner` in `DepositProgress.tsx`, the
   Pause/Resume header button + syncing-honesty in `SettingsView.tsx`): the paused state replaces
   the run banner (a parked run must never read as stalled), Resume lives on both surfaces, and a
   globally-paused run no longer shows folders as "Syncing".
3. **Deferred scope, not quality:** the 14-day nudge, `[open]` whether we want it at all.
