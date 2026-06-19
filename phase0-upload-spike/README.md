# Phase 0 — Kill/Resume Upload Spike

Proves the load-bearing claim of the [upload daemon design](../UPLOAD-DAEMON-DESIGN.md): a **journal-backed S3 multipart upload survives a hard kill and resumes** instead of restarting — the foundation of "the best upload experience."

## What it does
1. Splits a file into 16 MiB parts, multipart-uploads them to **Glacier Deep Archive**.
2. After **each part**, durably journals its number + ETag + SHA-256 (fsync'd JSON).
3. On restart, calls **`ListParts`** (S3 = source of truth), skips finished parts, finishes the rest.
4. Declares `SHA256` at `CreateMultipartUpload` so S3 **stores + validates** per-part checksums (the gotcha).
5. Completes, then `HeadObject` to verify.

## Prereqs
- Swift 6 toolchain — **macOS 13+ or a Linux dev container** (Swift + AWS SDK for Swift are cross-platform, and this spike uses `swift-crypto`, so it runs in your container too).
- AWS creds in the environment or default profile; a bucket you own — or point it at **MinIO / LocalStack** in your container to exercise resume/failures without real AWS.
- First `swift run` resolves dependencies — **bump `aws-sdk-swift` to the latest 1.x tag** in `Package.swift`.

> This is the **portable upload core** — see [daemon module split](../daemon-module-split.md). The macOS-only seam (Photos/TCC/launchd) is the separate [photos spike](../phase0-photos-spike/).

## Run it (with Taskfile, per house style)
```sh
task testfile                 # makes a 256 MiB test.bin
task spike BUCKET=your-bucket SPIKE_DELAY_MS=400   # delay makes it easy to kill mid-run
```

## The demo — watch it resume
1. Start `task spike BUCKET=…`. Let a few parts upload (`part 3/16 ✓ …`).
2. **`Ctrl-C`, or from another shell `kill -9 <pid>`** — anywhere, including right after a part journals.
3. Run the **same command again**. You'll see:
   ```
   ↻ Resuming upload abcd1234… — reconciling with S3
   ✓ 3/16 parts already on S3 — skipping those
     part 4/16 ✓ uploaded + journaled
     …
   ✅ Completed 16-part upload → s3://…
   ```
That's the whole point: no re-upload of finished parts, no corruption, no lost progress. Now imagine it's 500 GB over four days.

## Caveats / honesty
- **Generated SDK symbols:** the `*Input` initializers are generated — field *names* below are right, but argument *order* may differ by SDK version. Reorder if the compiler objects. `ByteStream` is in `Smithy` in 1.x (fallback: `ClientRuntime`).
- **Cleanup + the 180-day floor:** Deep Archive bills a **180-day minimum per object**, so even deleting `test.bin`'s object right after still bills ~6 months — though at 256 MiB that's ~$0.0015. Don't loop this on huge files.
- **Incomplete multipart staging cost:** if you kill and *never* resume, the in-progress parts bill at S3-Standard rates until aborted. Add an **abort-incomplete-multipart lifecycle rule (~14 days)** on the bucket — exactly what the real daemon will rely on.
- `task clean` removes the local journal + test file.

## What this de-risks
The resume/journal/reconcile spine of the daemon. It does **not** touch the *other* Phase 0 unknown — **TCC Photos-library access from a background binary** — that's a separate small spike.
