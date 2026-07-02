# Agentic Engineering Guidelines

## Project-specific settings

### Project-specific holy-commandments additions

- This is a PUBLIC REPO - no sensitive stuff please!

### Monorepo structure

Currently one product, **ColdStorage** (see the root [`README.md`](./README.md) for the full picture — orientation, state of the world, dev gotchas; [`PROD.md`](./PROD.md) is the active going-to-prod plan):

- `coldstorage/` — the Swift package: portable `ColdStorageCore` (engine, journal, crypto, control plane) + `ColdStorageMac` adapter (PhotoKit, FSEvents) + executables (`coldstored`, `coldstorectl`, `coldstore-cli`, `coldstore-restore`, `coldstore-photo-picker`). Docs: `coldstorage/README.md` (run it) + `coldstorage/DESIGN.md` (engine design + portable/Mac module split).
- `ui/` — the Electron/React control panel, a thin client over the daemon's control socket (Taskfile `ui:*`). Docs: `ui/DESIGN.md` (UX + daemon contract) + `ui/PACKAGING.md`.
- `account-backend/` — Hono API on Vercel + Neon/Drizzle: Cognito↔Paddle↔zero-knowledge-key-blob backend for the multi-user/paid layer (Taskfile `backend:*` + `link:account-backend`/`pull:account-backend`; see [`PROD.md`](./PROD.md) Phase 4). **Staging lane stood up 2026-07-02** (Neon staging DB, Paddle sandbox, real staging secrets, first deploy) — webhook gate test + the production lane (live Paddle, prod Neon branch, real prod secrets) still pending.
- `infra/coldstorage/` — Terraform/Terragrunt for S3 GDA + lifecycle + least-priv daemon IAM + Cognito (Taskfile `tf:coldstorage:*`; **APPLIED vs real AWS** — prod vault + IAM user + Cognito live. R2 still deferred until the thumbnail view needs it).
- `infra/account-backend/` — Terraform/Terragrunt for the account-backend's Vercel project: production + **staging** (the sandbox-Paddle case — a stable deployed URL + its own DB, isolated from real subscriptions), OIDC role + TF-managed env vars, Cognito ids read from `infra/coldstorage` (Taskfile `tf:account-backend:*`). **APPLIED for both stacks vs real AWS/Vercel providers**; staging's manual secrets are set for real, production's are still Terraform's placeholder.
- `phase0-upload-spike/`, `phase0-photos-spike/` — de-risking spikes (both run + proven; seeds of the core).
- `Taskfile.yml` — the single root command surface (`daemon:*`, `ui:*`, `backend:*`, `tf:coldstorage:*`, `tf:account-backend:*`, `link:*`/`pull:*` for Vercel projects). Use it for everything. `tf:plan`/`tf:apply`/`tf:init` and `link`/`pull` (no suffix) are interactive pickers over the namespaced tasks — same `read`/`select` + `case` convention throughout, not flag-passing.
- `strategy/` — **gitignored, private**: product spec, brand voice, economics. Not in the public repo.
