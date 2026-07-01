# Agentic Engineering Guidelines

## Project-specific settings

### Project-specific holy-commandments additions

- This is a PUBLIC REPO - no sensitive stuff please!

### Monorepo structure

Currently one product, **ColdStorage** (see [`ROADMAP.md`](./ROADMAP.md) for the full picture):

- `coldstorage/` — the Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`, `coldstore-photo-picker`). Has its own `README.md`.
- `ui/` — the Electron/React control panel, a thin client over the daemon's control socket (Taskfile `ui:*`). See `ELECTRON-UI-DESIGN.md` + `ui/PACKAGING.md`.
- `account-backend/` — Hono API on Vercel + Neon/Drizzle: Cognito↔Paddle↔zero-knowledge-key-blob backend for the multi-user/paid layer (Taskfile `backend:*` + `link:account-backend`/`pull:account-backend`; see [`PROD.md`](./PROD.md) Phase 4). **Code scaffolded, app not yet deployed** — its Vercel project infra IS applied (env vars/OIDC role live), but still needs a Neon DB + real Paddle credentials before the app itself does anything live.
- `infra/coldstorage/` — Terraform/Terragrunt for S3 GDA + lifecycle + least-priv daemon IAM (Taskfile `tf:coldstorage:*` wired; **scaffolded, `validate`-clean, and APPLIED vs real AWS** — prod vault + IAM user live. R2 still deferred until the thumbnail view needs it).
- `infra/account-backend/` — Terraform/Terragrunt for the account-backend's Vercel project: production + **staging** (the sandbox-Paddle case — a stable deployed URL + its own DB, isolated from real subscriptions), OIDC role + TF-managed env vars, Cognito ids read from `infra/coldstorage` (Taskfile `tf:account-backend:*`). **APPLIED for both stacks vs real AWS/Vercel providers** — `terragrunt state list` confirms it; manual secret values still need confirming (may still be Terraform's placeholder).
- `phase0-upload-spike/`, `phase0-photos-spike/` — de-risking spikes (seeds of the core; photos spike un-run, needs a Mac).
- `Taskfile.yml` — the single root command surface (`daemon:*`, `ui:*`, `backend:*`, `tf:coldstorage:*`, `tf:account-backend:*`, `link:*`/`pull:*` for Vercel projects). Use it for everything. `tf:plan`/`tf:apply`/`tf:init` and `link`/`pull` (no suffix) are interactive pickers over the namespaced tasks — same `read`/`select` + `case` convention throughout, not flag-passing.
- `UPLOAD-DAEMON-DESIGN.md`, `daemon-module-split.md` — design docs (engine spec; portable/Mac split).
- `strategy/` — **gitignored, private**: product spec, brand voice, economics. Not in the public repo.
