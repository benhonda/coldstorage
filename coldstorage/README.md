# ColdStorage daemon

The real foundation (supersedes the `phase0-*` spikes). A portable core does scan → plan → encrypt →
resumable multipart → verify → journal; the macOS adapter supplies PhotoKit behind one boundary. Built
to the four pillars: simple, best-practice, DRY, type-safe.

## Layout
```
Sources/ColdStorageCore/   # portable — builds/tests on Linux + macOS
  Models, IngestSource, LocalDirSource, Crypto, BlobPlanner, Journal, S3Store, UploadEngine
Sources/ColdStorageMac/    # macOS-only adapter (PhotoKitSource), #if canImport(Photos)-guarded
Sources/coldstore-cli/     # portable runner — archive a dir to S3/MinIO from your container
Sources/coldstored/        # macOS daemon entrypoint (stub: launchd loop + IPC next)
Tests/                     # Core tests, run in CI on Linux
```

## Run the whole pipeline (native — no Docker, no Mac)
Driven from the **root Taskfile**. From the repo root:
```sh
task daemon:setup        # one-time: Swift toolchain + MinIO binaries (idempotent)
task daemon:minio        # start local MinIO + bucket
task daemon:testdata     # sample files (coldstorage/testdata)
task daemon:build        # first build fetches deps
task daemon:archive      # scan → encrypt → resumable multipart → verify
# Ctrl-C mid-run, re-run `task daemon:archive` → it resumes from S3's truth
task daemon:test         # portable Core tests
```
> MinIO console: http://localhost:9001 (minioadmin / minioadmin).

## How robustness works (the crown jewel)
- **Deterministic encryption** — per-blob DEK + AES-GCM frames with counter nonces → a sealed blob is
  byte-reproducible, so re-staging on resume yields identical parts whose ETags match what's already up.
- **Journal (SQLite/WAL)** — every part/blob/file transition committed; a crash leaves a resumable state.
- **`ListParts` reconcile** — S3 is the truth on restart; done parts are skipped.
- **Layered integrity** — plaintext SHA-256 per file + per-part SHA-256 declared at `CreateMultipartUpload`
  (so S3 stores/validates) + `HeadObject` verify. "Archived" = verified, never "PUT 200".
- **Newest/most-precious-first** planning so recent + favorites land fast.

## Needs a first compile pass
Not compiler-verified here (Linux container, no Swift toolchain). The two likely fix points, both flagged
in-code: AWS SDK for Swift `*Input` initializer argument *order* (generated, varies by version), and the
`S3ClientConfiguration` endpoint/path-style property names for MinIO. These are minutes, not redesigns.

## Known stubs / TODO (next build chunks)
- `coldstored`: the launchd run-loop + local IPC socket for the Electron UI.
- `PhotoKitSource`: real plaintext hashing pre-pass (currently keys on `localIdentifier`).
- Restore path (selective, quote-before-commit) + R2 thumbnail/browse index.
- Cross-blob concurrency + adaptive throughput (engine is correct sequential today).
- Bucket lifecycle: abort-incomplete-multipart rule (Terraform).
