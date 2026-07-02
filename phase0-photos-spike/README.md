# Phase 0 — Photos TCC + Full-Res Original Spike

The riskier of the two Phase 0 unknowns (see [daemon design](../coldstorage/DESIGN.md)). Proves the two things that could quietly break the whole desktop-first bet:

1. A **signed, launchd-style binary** can hold a Photos permission that **persists across runs and under `launchd`** (not just when launched from Terminal).
2. We can read the **true full-res original** (`.photo` resource), **downloading from iCloud on demand** when "Optimize Mac Storage" left only a proxy local — the exact case the iOS review flagged.

## Why this is fiddly (the actual lesson)
TCC keys a permission to a **stable code-signing identity + an Info.plist usage string**. A bare unsigned CLI has neither, so grants don't stick. The fix, all demonstrated here:
- Embed an **Info.plist with `NSPhotoLibraryUsageDescription`** into the Mach-O (`-sectcreate __TEXT __info_plist`).
- **Codesign with a stable identity** (ad-hoc `-` works for local testing; an Apple Development cert is more reliable). **Re-signing with a different identity, or rebuilding without re-signing, resets the grant** — the #1 gotcha.
- Run/launch in the **user GUI session** → a **LaunchAgent**, never a LaunchDaemon (a system daemon has no Photos access).

## Run it
```sh
# 1. build + embed plist + sign
task build                       # or: task build IDENTITY="Apple Development: you@…"

# 2. first run from your GUI session → TCC prompt → Allow
task run                         # writes original-<name>.heic, prints whether it came from iCloud

# 3. PROVE PERSISTENCE: run again — no prompt, status starts as `authorized`
task run

# 4. PROVE IT UNDER launchd (the real daemon scenario)
#    edit the absolute path in com.coldstorage.photos-spike.plist, then:
task install-agent
cat /tmp/photos-spike.out        # should read an original with NO new prompt
```

## What "pass" looks like
- Step 3 prints `Photos authorization (start): authorized` with **no prompt** → grant persisted.
- Step 4's `/tmp/photos-spike.out` shows the same → a **launchd-spawned** process keeps the grant. ✅ desktop-first holds.
- If your newest photo's original was in iCloud, you'll see `iCloud download… 100%` then `downloaded on demand ✓` → we correctly handle the not-local original.

## If it fails
- `notDetermined`/`denied` on a fresh run after granting → **unstable signature** (rebuilt without re-signing, or different identity) or **missing embedded Info.plist**. Re-`task build`, keep `IDENTITY` constant.
- Re-test the prompt cleanly with `task reset-tcc`.

## Caveats / not-in-scope
- I can't run this here (Linux container) — it's untested by me; it targets macOS 13+/Swift 6 on your Mac.
- **Distribution later** adds: App Sandbox + `com.apple.security.personal-information.photos-library` entitlement, Hardened Runtime, and notarization. The spike stays **non-sandboxed** to isolate the TCC-persistence question.
- Public repo: nothing sensitive here — bundle id + usage string only.

## What this de-risks
The Photos/TCC seam for the daemon. Combined with the [upload spike](../phase0-upload-spike/), the two riskiest unknowns of the whole architecture are now cheaply testable **before** committing to the build.
