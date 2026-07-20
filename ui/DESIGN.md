# ColdStorage UI — design & decisions in force

> Moved from the root `ELECTRON-UI-DESIGN.md` (2026-07-02) and trimmed to what's in force. The daemon
> (`coldstored`) is the whole backend — the UI is a **thin client over its control socket**. Orientation:
> [`../README.md`](../README.md) · daemon design: [`../coldstorage/DESIGN.md`](../coldstorage/DESIGN.md) ·
> package/dev docs: [`README.md`](./README.md) · packaged-app state: [`PACKAGING.md`](./PACKAGING.md).

## What the UI is
A control panel for `coldstored`: browse your files, drop files in to upload, reorganize, watch live
progress, and request a copy back. It holds **no upload/restore logic** — the Swift daemon owns
scan/encrypt/upload/restore/journal. The UI reads state and sends commands.

> **UI work is design-led — "it compiles and renders" is not done.** The product's job is emotional
> ("I'll never lose these"), so feel and polish are the product, not decoration. Bind to the vendored DS
> tokens (`src/renderer/src/styles/tokens/`, SSOT) rather than one-off values, and treat a visual change as
> unfinished until it has been *looked at* on macOS. Corollary: if you're mid-way through non-UI work and
> tempted to casually restyle something, flag it instead — drive-by UX changes are how a design system
> quietly stops being one.

> **VOICE — plain file-uploader, no reassurance theater (Ben, 2026-06-24).** Don't tell the user their
> files are "safe," don't claim/advertise safety, don't editorialize ("steady", "reassuring"). Plain,
> factual verbs: **upload** (not "archive" as the active verb), **stored** (not "safe"), **request a
> copy** / **Start transfer** / **Transferring** (not "download"/"retrieve" — those imply immediacy;
> the slow-thaw nuance lives in the dialog, not the label), **frozen** (factual: deep storage is slow
> to open). Status is *information*, not comfort — neither alarm nor reassurance, just facts.

## The mental model — a reorganizable filesystem (canonical since 2026-06-24)
Two jobs are the whole product: **get files up** and **get them back**. The app does them as a
**drive you browse like a filesystem** — not a dashboard, not a sync-status panel.

- **Front door = the file browser itself.** No home dashboard; status is **ambient** (per-file badges
  + a plain storage line), never a separate screen of counts.
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
- **My Files** — the entire drive: browse, drop-to-upload, reorganize, request a copy.
- **Settings** — one door, two subpages (tabs): **General** (this-Mac behavior) and **Account**
  (identity/plan — configured installs only; the sidebar identity chip's popover deep-links here).

Sidebar is resizable; no docked detail panel — the per-row `⋯` (and right-click) opens actions,
**Get info** opens a modal.

```
┌────────────┬────────────────────────────────────────────────────────┐
│ ❄ coldstor.│  My Files › Photos › 2019              ⊞ ⊟    ⊕ Add      │
│            │  Name                          Size      Date            │
│  My Files  │  📁 January                    1.2 GB    12 items        │
│  Settings  │  📄 beach.jpg                  4.1 MB    Jul 12 2019  ✓ ⋯ │
│            │  📄 sunset.jpg                 3.8 MB    Jul 12 2019  ↓ ⋯ │
│            │  📄 hike.mov                   2.3 GB    Aug 3 2019      │
│ 12 GB      │                                                          │
│Transferring 1│ ────── drop anywhere to upload · right-click for more ─│
└────────────┴────────────────────────────────────────────────────────┘
   ⋯ → Get info · Rename · Move to… · New folder · Request a copy… · Delete
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
  amber ↓ **Transferring** · green `download_done`
  **saved on this Mac**. No icon = nothing in flight.
- **Selection is just selection** (cmd/shift multi → batch ops); details live behind `⋯`/right-click;
  double-click a file = Get info, a folder = drill in. No docked side-inspector.
- **Getting a copy back is a SECONDARY action, never a promoted CTA** — in the row menu + Get-info
  modal, labeled **"Request a copy…"** (*request* signals not-instant); the dialog's confirm is
  **"Start transfer"** and owns the "ready in ~a day" detail.
- **Empty/first-run:** a bounded, clickable drop-zone card (*"Drop files or folders to upload"* + one
  factual line "encrypted on your Mac before upload" + a "Choose files or folders" CTA). Delete-empty-folder
  skips the confirm (no bytes at stake).
- **Manipulation = standard Finder gestures:** rename (press-and-hold the name → inline edit, or the
  menu — NOT double-click, which opens), new folder, drag-to-move (spring-loaded: hold over a
  folder/crumb and it opens under the drag), delete (⌫ → confirm). **Delete =
  instant tombstone** with honest copy: *"removes it from your files; it doesn't lower your cost for
  180 days"* (Deep Archive minimum-duration; never imply delete-to-save-money). Byte reclamation is
  deferred/rare (thaw-to-repack — backend concern, invisible here).

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

## Request-a-copy flow (available, not advertised)
1. Trigger from the row `⋯` / Get-info modal; works on one file, a multi-select, or a folder.
2. **Confirm = explicit modal** (paid + multi-hour → never accidental), button **"Start transfer"**:
   file · size · **ready in ~a day (up to 48h)** · **cost ~$X** · a "Save to" row with the native
   folder picker (defaults to Downloads, chosen per request — no global setting) · "you can close the
   app — we'll fetch it and let you know."
3. **In-flight = named stages, NEVER a fake progress bar** (Deep Archive reports only warming vs
   ready): **Preparing** (~12–48h, the honest unknown) → **Downloading** → **Ready**, with a quoted
   ready-by time.
4. **Ready → macOS system notification** (walk-away is the whole design): *"wedding.mov is ready — in
   your Downloads folder [Show] [Open]."* *(Notification still open, below.)*
5. The local copy expires after the requested `days`, then re-freezes → honest *"available until
   Jun 28,"* download-again is one click.
6. A persistent **"Transferring N"** indicator in the sidebar foot (→ queue popover) survives app close.
7. Batch/folder request → one **combined** quote (`240 files · ~a day · ~$3.10`).

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
  a live status badge (🟢 Up to date · 🔵 Syncing… · 🟠 Not watching — driven by the live `run.active`,
  not the poll-only `status.running`), and a ghost `⋯` with **Stop/Start watching** (persistent
  per-source pause; the amber badge + dimmed row keep a stopped folder from looking protected) and
  **Remove…** (confirm — uploaded files stay). Watched folders carry a **destination mount**
  (`mountPath`, defaults to the source basename, never root) chosen in the add dialog via the shared
  `FolderTree` drill-in picker; Model A (mirror mount) — watched trees stay daemon-owned/structure-
  preserving, reorg is reserved for manual deposits. Manual deposits are unaffected by pause.
- **Don't back up (excludes):** friendly removable chips over real gitignore-style globs, seeded with
  smart defaults; daemon is the SSOT (journal-persisted, applied *inside* the directory walk so junk
  is never hashed and node_modules is pruned whole). Per-source extras are a later refinement.
- **This Mac:** the encryption fact ("on this Mac, before upload" — plain, no "safe", no privacy
  over-claim). In **dogfood mode** this card is the original **Storage** card instead — the quota row
  stays here because there's no Account subpage to carry it.

### Account — who's signed in, what they pay for (configured installs only)
- **Account card:** Name (inline edit) + Signed in as, with **Sign out** as the header action.
- **Plan & billing card:** Plan row (badge + Change plan → `ChangePlanModal`), the quota row (below),
  Subscription state (Active · renews / Free + Upgrade / Ends date), then **Billing folded behind an
  inline disclosure** (Update payment method · Cancel subscription) — destructive last, state always
  visible, actions two clicks, never staring at you.
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
  listExcludes · addSource · removeSource · addExclude · removeExclude · restorePlan · restore ·
  deposit · depositPhotos · previewDeposit · movePath · createFolder · deletePath · authenticate ·
  deauthenticate · mintVault · unlockVault · unlockVaultWithRecoveryCode · lockVault · triggerNow ·
  pauseSource · resumeSource`. (`authenticate`/`deauthenticate` = the **session** opened/closed —
  per-user S3 creds plus the user's journal, staging dir and key holder; the `*Vault*` four = the
  zero-knowledge encryption key, loaded/cleared over the local socket — all multi-user only, see
  PROD.md Phase 5.)
- **Session lifecycle — the daemon serves ONE user, or none.** `authenticate` builds the session
  (`UserSession`), `deauthenticate` destroys it; a different Cognito `sub` tears the old one down first.
  **Signed out, the daemon serves nothing:** `getStatus`/`listFiles`/`listSources`/`listExcludes` return
  the empty answer, everything else errors *"not signed in"*. `getStatus` now carries **`signedIn:
  boolean`** (and `bytesStored: number | null` — non-null whenever signed in). The renderer must NOT
  keep rendering the previous account's tree: `authChanged` resets every vault-derived slice
  (files/status/excludes/run/failures/restores) on sign-out **and** on an account switch, keyed on the
  account — the daemon's isolation is only half the fix if the UI still holds the last user's state.
- **Events (SSOT = the `DaemonEvent(...)` call sites):** `runStarted · fileArchived · uploadProgress ·
  runProgress · runFinished · blobFailed · sourcesChanged · filesChanged · excludesChanged ·
  restoreRequested · restoreInProgress · restoreCompleted · restoreNeedsAuthorization · error`.
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
- `ui/src/main/auth/` — sign-in (PROD.md Phase 5), two lanes into ONE token lifecycle: Google via
  Cognito managed-login OAuth (`oauth.ts` — PKCE, system browser, `coldstorage://auth/callback` deep
  link packaged / loopback in dev) and email one-time-code via the Cognito API as plain HTTPS JSON-RPC
  (`cognito-idp.ts` — SignUp/ConfirmSignUp/InitiateAuth/RespondToAuthChallenge, no SDK). `manager.ts`
  holds tokens (access/ID in memory, refresh token safeStorage-encrypted), is **lane-aware** (each
  session tagged `oauth`|`email`, refreshed at its own endpoint), and runs the daemon handoff (fresh ID
  token → `authenticate`). The renderer sees only `AuthStatus` over IPC — never a token. Gate UI:
  `views/SignInView.tsx` (Google + the email step machine) + the account card in Settings.
- `ui/src/main/vault/` — the zero-knowledge vault (PROD.md Phase 5b): the encryption-key half of being
  signed in. `manager.ts` decides per-device — cached MK → `unlockVault`; new account → `mintVault` +
  store the key-blob + show the recovery code once; new device → prompt + `unlockVaultWithRecoveryCode`.
  `keyblob-client.ts` = blind GET/PUT at the account backend; `storage.ts` = per-account MK escrow in
  safeStorage. Renderer sees only `VaultStatus` (never key material, except the one-time code to show).
  Gate UI: `views/RecoveryCodeView.tsx`. The daemon handoff runs `authenticate` THEN vault `provision`.
- `ui/src/main/entitlement/` — subscription billing (PROD.md Phase 5c): `manager.ts` fetches
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
  `views/PlanPicker.tsx`); Settings shows the state. `coldstorage://checkout-complete` is a check-now nudge. **Manage surface (2026-07-10, PADDLE.md "Managing a subscription"):**
  `getSubscription()/previewPlanChange()/changePlan()/openManage()` → the sidebar's pinned
  `views/AccountCard.tsx` (avatar · email · a Drive-style storage meter fed by the gate's own
  used/quota figures; the plan-size badge only when the meter can't name the quota; click → a
  popover: identity summary + "Settings…" deep-linking to Settings › Account + Sign out)
  + Settings › Account
  (plan row + `views/ChangePlanModal.tsx` with a proration preview; cancel/payment-method open
  Paddle-hosted pages in the browser).
- `src/renderer/src/styles/tokens/` — the 5 DS token CSS files **vendored verbatim** (SSOT — re-sync,
  don't hand-edit) from the coldstorage Design System (Claude Design `41ebafc1`), ported to native
  React 19 TSX (the DS's UMD/CDN runtime isn't consumable in electron-vite). Primitives in
  `src/renderer/src/ui/`; the browser's domain components + pure model in `src/renderer/src/views/files/`
  (headless-tested). Fonts self-hosted (Fontsource + material-symbols) for the locked-down CSP.

## Remaining UI-lane work (still open)
1. **Per-file live status:** icons need `frozen | uploading | failed | gettingBack | here` per file —
   fold journal `FileStatus` with live restore state (restore state is per-request via `restore*`
   events today, not queryable per file).
2. **Skipped-count reporting** (daemon): the deposit "skipped 1,203" line needs the run to report how
   many files the excludes filtered. Also a per-run **filesFailed** count (blobs ≠ files).
3. **Retry depth:** row Retry re-issues `deposit` from the remembered `srcPath`; a failure *after* the
   daemon accepted it (journal row, no `srcPath`) needs daemon support to retry.
4. **Polish:** macOS notification on restore-ready; `Show in Finder` (`shell.showItemInFolder`);
   subset the 5.3 MB Material Symbols woff2 to the ~12 glyphs used.
5. `newFolder` is local-only until something lands in it (a virtual path — nothing to persist).

## Gotchas (save the next agent hours)
- **Browse is NOT R2-blocked — only photo thumbnails + cross-device index portability are.** Deep
  Archive freezes object *bytes*, never *metadata*, and the tree comes from the journal (not
  `ListObjectsV2` — blobs are opaque `blobs/<hash>` objects). Don't block browse work on R2.
- **Socket perms:** `0600`, same user — fine. Dev socket `coldstorage/coldstored.sock`; installed
  `~/Library/Application Support/ColdStorage/coldstored.sock` (`COLDSTORE_SOCKET`).
- **Restore is idempotent/one-step:** `restore` returns `state ∈ restored | thawRequested |
  thawInProgress` (+ `typicalWait`). Call, show the quoted wait, re-issue / reflect `restore*` events.
  Don't expect one call to block for hours.
- **JS tooling is Bun** (repo convention), but Electron's main runs its bundled Node — dev/test on Bun,
  ship on Node, only `node:net`. Add deps with `bun add <pkg>@latest`.
- `node_modules` is platform-native — each OS needs its own `bun install` (the container uses a named
  volume; see [`README.md`](./README.md)).
- **The daemon's state is per-user, under a data ROOT** (`COLDSTORE_DATA_DIR`): journal, staging and
  `status.json` live at `<root>/users/<sub>/`, opened at sign-in. The old per-file env vars
  (`COLDSTORE_JOURNAL`/`_STAGING`/`_STATUS`/`_KEK`) are gone; `main/daemon.ts` passes the root.
  `status.json` is a run summary the daemon writes — the socket is the live source.
- **Pull current docs via Context7** before deep React/Vite/Electron work.
