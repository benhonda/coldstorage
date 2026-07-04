# Packaging ColdStorage.app

> **Status (2026-06-28): packaged app BUILDS + LAUNCHES + CONNECTS on a real Mac ✅ — but the identity
> goal is NOT achieved yet.** A packaged `ColdStorage.app` now bundles + supervises its own `coldstored`
> (approach B) and the UI reaches "connected". HOWEVER, the on-device test showed the Photos privacy pane
> **still lists "coldstored", not "ColdStorage"** — responsible-process attribution did NOT make the child
> inherit the app's TCC identity (and this was an *ad-hoc*-signed build, which gives TCC an unstable,
> filename-defaulted identity anyway). So the original screenshot problem is **still open**; see
> "Identity — UNRESOLVED" below. Two things also remain before it's actually usable: ~~production AWS
> credentials (the app connects but can't upload)~~ **AWS creds wiring is now BUILT (2026-06-29) — pending
> Ben's Mac verify** (`task ui:bootstrap` + `config.json`; see "Production AWS credentials" below) and real
> code signing.

## Why this exists

`coldstored` currently installs as an **unbundled** Mach-O binary via a LaunchAgent (`task daemon:install`).
macOS TCC labels unbundled path-clients by their **executable filename** — so users see "coldstored", not
"ColdStorage", and the grant is brittle (re-signing/rebuilding orphans it; the `-10814` gotcha). Only a
proper `.app` bundle gets a `CFBundleDisplayName` + icon + a stable bundle id. So: package the app (#1),
then move the daemon inside it as an SMAppService helper (#2).

## What's scaffolded here

- `electron-builder.yml` — appId `com.theadpharm.coldstorage`, productName **ColdStorage**, mac target
  (dmg + zip), hardened runtime, entitlements, and the release Swift binaries bundled to
  `Contents/Resources/bin/`. (electron-builder **v26** syntax — signing fields top-level under `mac`.)
- `build/entitlements.mac.plist` — hardened-runtime entitlements Electron needs (JIT heap, dyld env,
  library-validation off); deliberately **not** sandboxed (the app opens the unix control socket + spawns
  the bundled helpers).
- `task ui:package` — builds release Swift binaries → `electron-vite build` → `electron-builder --mac`.
- `main/system.ts` resolves `coldstore-photo-picker` from `Contents/Resources/bin` when `app.isPackaged`.

## Build it (on your Mac)

```
task ui:package      # → ui/dist/ColdStorage.app + .dmg + .zip
```

Unsigned/unnotarized by default, so it runs locally without certs. To produce a **distributable**:

## Before it's shippable — the Mac-iteration TODOs

These genuinely need on-device iteration (can't be done/verified off a Mac):

1. **Icon** — add `build/icon.icns` (1024px, from the Design System). Without it electron-builder uses its
   stock Electron icon. *This is also the icon users will see in the Photos privacy list.*
2. **Signing + notarization — WIRED ✅ (2026-07-04), pending Ben's Mac + certs to run.** `task ui:release`
   drives build → sign → notarize → publish. It needs a **Developer ID Application** cert in your login
   keychain (electron-builder auto-discovers it; or set `CSC_LINK`/`CSC_KEY_PASSWORD`) + notary creds in the
   env or the gitignored `.env`: `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific
   password from appleid.apple.com). The task overrides the yml's `notarize: false` default to true on the
   CLI, so plain `task ui:package` stays cert-free for local smoke tests. Use a STABLE identity — the Photos
   TCC grant is keyed to it (same constraint `daemon:install` documents).
3. **Nested-binary signing — WIRED ✅ (2026-07-04).** `electron-builder.yml` `mac.binaries` now lists the
   three bundled Swift Mach-Os so electron-builder signs them inside-out with the app's Developer ID +
   hardened runtime (notarization rejects any unsigned nested binary). `coldstored` carries its
   `-sectcreate` Info.plist (Photos usage string); **confirm on the signed build that it survives the
   re-sign** — `task ui:package:verify` prints each binary's signature/authority.

## Auto-update (Phase 6b) — GitHub Releases

The packaged app self-updates from **GitHub Releases** (the repo is public → free, CDN-backed assets, no new
infra). electron-updater lives in `src/main/updater/` (`manager.ts` = the state machine, `ipc.ts` = the seam),
wired into `main/index.ts` packaged-only:

- **Feed:** `electron-builder.yml` `publish: github benhonda/coldstorage`. `task ui:release` uploads the
  `.dmg` + `.zip` + `latest-mac.yml` metadata to a release tagged `v<version>`; the app reads that same feed.
  (The `zip` target is required — electron-updater applies macOS updates from the `.zip`, not the `.dmg`.)
- **Flow:** on launch + every 6h it checks, background-downloads a newer *signed* build, and surfaces a quiet
  "Restart to update" banner on `update-downloaded`. Restart = `autoUpdater.quitAndInstall()`, whose app-quit
  SIGTERMs the supervised `coldstored` child via the existing `will-quit`. Ignored → installs on the next quit.
- **Renderer:** an `UpdateStatus` is pushed over the SAME manager→ipc→controller→store seam as
  auth/vault/entitlement; the banner shows only in the `ready` state (calm, non-urgent voice). Dev is inert
  (a no-op port — auto-update can't run unpackaged/unsigned).
- **Cutting a release:** bump `ui/package.json` `version` (semver — the update comparison), commit + push,
  then `task ui:release`. **macOS refuses to apply an update to an unsigned/ad-hoc app**, so end-to-end
  self-update only works once 6a's Developer ID signing is in place — an `ui:package:sign-adhoc` build can't
  self-update.
- **Provenance guard:** `ui:release` refuses unless you're on a **clean, pushed `main`**. Why: electron-builder
  uploads to a *draft* release, and when that draft is published GitHub creates the `v<version>` tag on
  **main's latest remote commit** — not your working tree. So a dirty tree, a feature branch, or unpushed
  commits would ship a binary that no tag reproduces (bad for a feed users auto-pull). Bypass with
  `RELEASE_FORCE=1` if you truly mean to. To rehearse a signed + notarized build **without** publishing (no
  release, no tag, no `GH_TOKEN`, no guard), use **`task ui:release:dryrun`** → `ui/dist/`.

## Step #2 — app owns its daemon (approach **B**): CONNECT ✅, IDENTITY ❌

We rejected SMAppService (`SMAppService.agent(plistName:)` must run in the app's main-bundle context; our
main process is Electron/Node → needs a native addon). Instead the **packaged app owns its daemon**: it
spawns `coldstored` as a child, supervises it (KeepAlive-style restart), kills it on quit. Tradeoff: the
daemon runs while the app runs (menu-bar/Backblaze model), not as an independent launchd service.

**Wired + PROVEN on a real Mac (2026-06-28) — the app reaches "connected":** (`main/daemon.ts` + `main/index.ts`)
- Spawn/supervise the bundled `coldstored` (packaged only); per-user data dir = `app.getPath("userData")`
  (`~/Library/Application Support/ColdStorage` — same `DATA_DIR` `task daemon:logs` tails).
- Socket SSOT: `daemonSocketPath()` feeds both the daemon's `COLDSTORE_SOCKET` and `new DaemonClient({…})`,
  so the packaged app dials the child it just launched (this is what fixed "Connecting…").
- `app.setName("ColdStorage")` pins userData so the client's (module-load) and daemon's (whenReady) socket
  paths can't diverge; `app.setLoginItemSettings({ openAtLogin: true })` for reboot persistence.

### Identity — UNRESOLVED (the original "coldstored" screenshot is still open)

The premise that a child inherits the app's TCC identity via **responsible-process attribution was WRONG**
in practice: the on-device test (2026-06-28) still showed `coldstored` in System Settings ▸ Privacy &
Security ▸ Photos, not "ColdStorage". A plain child keeps its OWN identity (it has its own signature +
embedded Info.plist). Compounding it, the test build is **ad-hoc** signed, which gives TCC an unstable,
filename-defaulted identity regardless — so a clean verdict isn't even possible until proper signing.

**Untested caveat:** unconfirmed whether a fresh Photos *prompt* actually fired during the test, or whether
the pane just showed the stale entry from the old `daemon:install`. Worth re-checking on a signed build.

Options for when we return to this (need a **properly signed** build to evaluate any of them):
1. **Native disclaim-responsibility launcher** — a tiny shim that `posix_spawn`s `coldstored` with
   `responsibility_spawnattrs_setdisclaim(…, 1)` so its responsible process becomes the app. The documented
   way a helper shares the app's TCC identity. (Native code — the thing B was meant to avoid.)
2. **Embedded-Info.plist experiment (cheapest)** — set `CFBundleName=ColdStorage` (+ identifier + icon) in
   `coldstored`'s `-sectcreate` Info.plist and see if TCC shows it. Unverified; try first on a signed build.
3. **SMAppService** via a small Swift registration helper or native addon — the "proper" route we deferred.

**Recommendation (2026-06-28):** the label is cosmetic for self-dogfooding and un-judgeable on an ad-hoc
build — defer it to the signing milestone. Prioritize the two things that block actually USING the app:

**Still to do (own milestones):**
- **Production AWS credentials** for a Finder-launched app — **BUILT ✅ (2026-06-29), PENDING Ben's Mac
  verify.** A Finder-launched app inherits no shell env, so the daemon started + served the socket but
  **uploads couldn't complete** (the real dogfooding blocker). Fix reuses the launchd machinery wholesale:
  the supervisor (`main/daemon.ts`) reads a per-user **`config.json`** in the app's data dir
  (`~/Library/Application Support/ColdStorage/config.json` → `{bucket, region, awsProfile,
  cognitoIdentityPoolId, cognitoUserPoolProvider}` — the last two added 2026-07-01 for the Cognito
  multi-user seam, PROD.md Phase 2c; empty/absent until `tf:coldstorage:creds-export` has been re-run
  since) and injects `COLDSTORE_BUCKET`/`AWS_REGION`/`AWS_PROFILE`/`COLDSTORE_COGNITO_IDENTITY_POOL_ID`/
  `COLDSTORE_COGNITO_USER_POOL_PROVIDER` into the daemon env — exactly what `daemon:install` bakes into the
  launchd plist. **No secret is in config.json**: creds resolve via the `coldstorage` profile's
  `credential_process → Keychain`, the same path `task daemon:creds` already sets up. Write it with
  **`task ui:config`** (from the infra-outputs handoff SSOT) or **`task ui:bootstrap`** (`daemon:creds` +
  `ui:config`, the .app analogue of `daemon:bootstrap`). Reading is best-effort — a missing/malformed file
  logs + the daemon still starts (graceful "connected but can't upload" degrade).
  `task ui:package:doctor` now reports config.json + runs `aws sts get-caller-identity` on its profile —
  **but note it auto-discovers by data dir, which the packaged app SHARES with the launchd daemon (see the
  NOTE just below), so a `daemon:install`ed launchd daemon still running will make `doctor` report on
  *that* process, not the packaged app's own bundled `coldstored` — check the binary path it prints
  (`Contents/Resources/bin/coldstored` = the real packaged-app process).**
  **NOTE: the packaged app's data dir == the launchd daemon's `DATA_DIR`** (both `~/Library/Application
  Support/ColdStorage`, same `coldstored.sock`) — don't run both at once; `task daemon:uninstall` the
  launchd one before dogfooding the .app. **Ben to verify on Mac:** `task ui:bootstrap` → launch the .app →
  deposit a file → confirm it lands in the prod vault (`task ui:package:doctor` should show a valid Arn).
- **Real code signing** (Developer ID / the Apple Development cert `daemon:install` already uses) — needed
  for arm64 launch beyond the ad-hoc stopgap, for the grant to persist across rebuilds, AND to even judge
  the identity options above. Confirm electron-builder signs `Contents/Resources/bin/*` (may need `mac.binaries`).
- **Background-run UX** — a **Tray** + `LSUIElement` so the always-running app lives in the menu bar, plus a
  Settings toggle for `openAtLogin`. Pairs with a UX session.
- **Delete the `photos-spike` TCC entry** — dev cruft visible in the same pane.

## Related runtime wiring still on dev paths

- `main/system.ts` prefers the bundled picker when packaged; `coldstore-restore` follows the same
  `process.resourcesPath/bin` pattern when the restore flow is wired into the packaged app.
