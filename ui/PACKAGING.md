# Packaging ColdStorage.app

## Why a bundle at all

`coldstored` on its own is an unbundled Mach-O, and macOS TCC labels those by **executable filename** —
so the Photos privacy pane says "coldstored", and the grant is brittle (re-signing orphans it, the
`-10814` gotcha). Only a real `.app` gets a `CFBundleDisplayName`, an icon, and a stable bundle id.

## What's here

- **`electron-builder.cjs`** — the build config (CommonJS, not `.yml`, so identity can be per-lane; pass
  `--config electron-builder.cjs` explicitly, since the default config name is still `.yml`). mac target
  (dmg + zip), hardened runtime, entitlements, and the release Swift binaries bundled into
  `Contents/Resources/bin/`. `appId`/`productName`/URL scheme are **not** hardcoded — they come from the
  freshly baked `build/app-config.json`. Notarization is driven by `COLDSTORE_NOTARIZE`, because a `-c`
  nested override can't coexist with `--config`.
- **`identity.json`** — SSOT for the app's install identity, keyed by lane. Adding or renaming a lane is
  a one-file edit; a new scheme also needs its `<scheme>://auth/callback` added to the Cognito callback
  URLs (`infra/coldstorage/modules/stack/variables.tf`, `app_oauth_callback_urls`).
- **`build/entitlements.mac.plist`** — the hardened-runtime entitlements Electron needs (JIT heap, dyld
  env, library-validation off). Deliberately **not** sandboxed: the app opens a unix control socket and
  spawns bundled helpers.
- **`mac.binaries`** lists the three bundled Swift Mach-Os so they're signed inside-out with the app's
  Developer ID — notarization rejects any unsigned nested binary. `coldstored` keeps its `-sectcreate`
  Info.plist for the Photos usage string.

## Building

```
task ui:mac:package        # local build → ui/dist/  (unsigned, no certs needed)
task ui:mac:release        # the real thing: bump → build → sign → notarize → upload → verify → publish
task ui:mac:release:dryrun # signed + notarized, publishes nothing
```

`ui:mac:release` needs a **Developer ID Application** cert in the login keychain (an *Apple Development*
cert is not valid for notarized distribution — `task ui:mac:sign:doctor` tells them apart) plus notary
creds in the env or the gitignored `.env` (`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`;
`task ui:mac:notarize:doctor` probes them against Apple directly).

It refuses unless you're on a **clean, pushed `main`** — electron-builder builds the working tree, but
the tag GitHub creates on publish points at `origin/main`'s head, so anything else ships a binary its own
tag doesn't reproduce. `RELEASE_FORCE=1` overrides. It also can't ship a version twice: the bump guard
requires `ui/package.json` to be strictly ahead of `releases/latest`.

The sub-steps stay individually runnable for when something breaks midway —
`ui:mac:release:upload` / `:verify` / `:publish`, the last of which finishes a release that uploaded but
never published, with no rebuild or bump.

**Logic lives in `ui/scripts/*.ts`, not inline in the Taskfile.** Not stylistic: the inline `node -e`
version of the asset check silently broke when a message string contained an apostrophe and closed the
shell's quoting mid-script. Nothing typechecks inline shell, and `bash -n` doesn't catch it — the shell
stays syntactically valid.

## Auto-update

The packaged app self-updates from **GitHub Releases** (public repo → free, CDN-backed, no new infra).
`src/main/updater/` holds the state machine and the IPC seam; it's packaged-only, inert in dev, since
macOS refuses to apply an update to an unsigned app.

- The `zip` target is **required** — electron-updater applies macOS updates from the `.zip`, not the
  `.dmg`. A release uploads `.dmg` + `.zip` + `latest-mac.yml`, and the app reads that same feed.
- Checks on launch and every 6h, background-downloads a newer signed build, and surfaces a quiet
  "Restart to update" banner. Restart is `quitAndInstall()`, whose app-quit SIGTERMs the supervised
  `coldstored` child via the existing `will-quit`. Ignored → installs on the next quit.

## Two lanes that must never cross

The bake (`task ui:config:bake ENV=production|staging`, run inside the packaging tasks) picks both the
account-backend URL and the install identity, so a staging build installs *alongside* prod with its own
bundle id, data dir, and deep-link scheme. `ENV` is required — no silent default — because a customer
build wired to staging would strand the user's encrypted MasterKey in the test DB. Cognito and the vault
bucket are shared across lanes; the key-blob is not.

## The app owns its daemon

We rejected `SMAppService` (`SMAppService.agent(plistName:)` must run in the app's main-bundle context;
our main process is Electron/Node, so it would need a native addon). Instead the packaged app spawns
`coldstored` as a child, supervises it, and kills it on quit — the menu-bar/Backblaze model. Tradeoff:
the daemon runs only while the app runs.

`daemonSocketPath()` feeds both the daemon's `COLDSTORE_SOCKET` and the client, so the app always dials
the child it just launched. `app.setName(productName)` pins userData before either resolves a path, so
they can't diverge — read from the **baked** config only, never the user's `config.json`, since a
dogfood override must not repoint the data dir the app is already on.

**Gotcha: the packaged app's data dir is the same as the launchd daemon's** (`~/Library/Application
Support/ColdStorage`, same socket). Don't run both — `task daemon:mac:uninstall` the launchd one before
dogfooding the `.app`. This also fools `ui:mac:package:doctor`, which auto-discovers by data dir; check
the binary path it prints (`Contents/Resources/bin/coldstored` is the packaged app's own process).

## Open: the TCC label

The Photos privacy pane may still list **"coldstored"** rather than **"ColdStorage"**. The original
premise — that a child inherits the app's TCC identity through responsible-process attribution — was
wrong in testing (2026-06-28): a plain child keeps its own identity, having its own signature and
embedded Info.plist. That test was on an ad-hoc-signed build, which gives TCC an unstable
filename-defaulted identity anyway, so it was never a clean verdict; it wants re-checking on a signed
build, which now exists.

If it's still wrong, in ascending cost: set `CFBundleName`/identifier/icon in `coldstored`'s
`-sectcreate` Info.plist and see if TCC honours it; a native shim that `posix_spawn`s the daemon with
`responsibility_spawnattrs_setdisclaim` (the documented way a helper shares the app's identity); or
`SMAppService` via a Swift registration helper.

Cosmetic for dogfooding, not for customers.
