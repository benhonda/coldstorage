# Agentic Engineering Guidelines

## Project-specific settings

### Project-specific holy-commandments additions

- This is a PUBLIC REPO - no sensitive stuff please!

### Monorepo structure

Currently one product, **ColdStorage** (see [`ROADMAP.md`](./ROADMAP.md) for the full picture):

- `coldstorage/` — the Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`, `coldstore-photo-picker`). Has its own `README.md`.
- `ui/` — the Electron/React control panel, a thin client over the daemon's control socket (Taskfile `ui:*`). See `ELECTRON-UI-DESIGN.md` + `ui/PACKAGING.md`.
- `account-backend/` — Hono API on Vercel + Neon/Drizzle: Cognito↔Paddle↔zero-knowledge-key-blob backend for the multi-user/paid layer (Taskfile `backend:*`; see [`PROD.md`](./PROD.md) Phase 4). **Scaffolded, not deployed** — the Vercel project exists (`coldstorage-account-backend`) but needs a Neon DB + Paddle credentials before it does anything live.
- `infra/coldstorage/` — Terraform/Terragrunt for S3 GDA + lifecycle + least-priv daemon IAM (Taskfile `tf:coldstorage:*` wired; **scaffolded, `validate`-clean, and APPLIED vs real AWS** — prod vault + IAM user live. R2 still deferred until the thumbnail view needs it).
- `infra/account-backend/` — Terraform/Terragrunt for the account-backend's Vercel project: production + **staging** (the sandbox-Paddle case — a stable deployed URL + its own DB, isolated from real subscriptions), OIDC role + TF-managed env vars, Cognito ids read from `infra/coldstorage` (Taskfile `tf:account-backend:*`). **Plans clean for both stacks vs real AWS/Vercel providers, not yet applied.**
- `phase0-upload-spike/`, `phase0-photos-spike/` — de-risking spikes (seeds of the core; photos spike un-run, needs a Mac).
- `Taskfile.yml` — the single root command surface (`daemon:*`, `ui:*`, `backend:*`, `tf:coldstorage:*`, `tf:account-backend:*`). Use it for everything.
- `UPLOAD-DAEMON-DESIGN.md`, `daemon-module-split.md` — design docs (engine spec; portable/Mac split).
- `strategy/` — **gitignored, private**: product spec, brand voice, economics. Not in the public repo.
