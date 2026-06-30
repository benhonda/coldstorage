# Agentic Engineering Guidelines

## Project-specific settings

### Project-specific holy-commandments additions

- This is a PUBLIC REPO - no sensitive stuff please!

### Monorepo structure

Currently one product, **ColdStorage** (see [`ROADMAP.md`](./ROADMAP.md) for the full picture):

- `coldstorage/` — the Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`, `coldstore-photo-picker`). Has its own `README.md`.
- `infra/coldstorage/` — Terraform/Terragrunt for S3 GDA + lifecycle + least-priv daemon IAM (Taskfile `tf:coldstorage:*` wired; **scaffolded, `validate`-clean, and APPLIED vs real AWS** — prod vault + IAM user live. R2 still deferred until the thumbnail view needs it).
- `phase0-upload-spike/`, `phase0-photos-spike/` — de-risking spikes (seeds of the core; photos spike un-run, needs a Mac).
- `Taskfile.yml` — the single root command surface (`daemon:*`, `tf:coldstorage:*`). Use it for everything.
- `UPLOAD-DAEMON-DESIGN.md`, `daemon-module-split.md` — design docs (engine spec; portable/Mac split).
- `strategy/` — **gitignored, private**: product spec, brand voice, economics. Not in the public repo.
