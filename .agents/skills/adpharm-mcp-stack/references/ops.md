# Ops — Taskfile, provisioning, dev loop, deploy

Owns how the Worker is run, provisioned, and deployed. The `mcp:` task block itself lives once, in `assets/Taskfile.mcp.yml` — this file explains it.

**Read when:** wiring the Taskfile, provisioning (KV, secrets, OAuth client), setting up the dev loop, or deploying.

## Contract

- All Worker ops go through the root `Taskfile.yml` under an `mcp:` prefix (TP1). Merge `assets/Taskfile.mcp.yml` in and change `dir:` + secret names.
- Everything runs through `bunx` — no global installs to document. `interactive: true` on anything wrangler that opens a browser, prompts, or streams.
- The dev loop is `task mcp:dev` → mprocs runs `wrangler dev` + the **MCP Inspector** together (they always go together; the Inspector is how you exercise tools without a real MCP client). `assets/mprocs.yaml` is the pairing.

## Non-negotiables

| key | rule | why |
| --- | --- | --- |
| wrangler-jsonc-is-iac | don't put a single Worker + KV in Terraform — `wrangler.jsonc` already version-controls the Worker, DO binding + migration, and vars declaratively | TF means a second pipeline for marginal benefit; DO migrations + bundling are wrangler-owned anyway. Revisit only for a custom domain or access proxy, and then as a small standalone Cloudflare config — never folded into an AWS Terragrunt tree |
| provisioning-recorded | the raw provisioning commands live in tasks + README — that *is* the provisioning record, since it isn't in TF | console steps with no record are how setups become unreproducible |
| typecheck-regens-types | the Worker's `package.json` script is `"typecheck": "wrangler types && tsc --noEmit"` — regen **in the script**, not only in the Taskfile | a binding rename in `wrangler.jsonc` must become a compile error for whoever invokes typecheck, including CI (PILLAR4). One reference build split these and has this exact hole |
| account-id-first | set `account_id` in `wrangler.jsonc` **before** running any task that reaches the Cloudflare API — a placeholder fails `mcp:kv-create` with `could not retrieve internal account ID [code: 10015]`, which reads like a login failure and isn't | wrangler reads `account_id` from config before every API call, and our operators have access to several Cloudflare accounts, so it can't infer one — pinning it also stops a deploy landing in the wrong account |
| cf-auth-guard | every task that talks to the Cloudflare API `deps:` on `mcp:check-cf-auth` (the `whoami --json` check passes for token auth too) | an actionable "set the token" beats a raw wrangler error |
| devcontainer-token-auth | in a devcontainer, auth wrangler with `CLOUDFLARE_API_TOKEN` in the root `.env` (dotenv-loaded by the Taskfile; "Edit Cloudflare Workers" token template). `mcp:cf-login` (browser OAuth, `--callback-host 0.0.0.0`) is the fallback for non-container use | wrangler's OAuth page always redirects the **host** browser to `localhost:8976`, which only reaches wrangler if VS Code forwards host 8976 to *this* container — stale forwards survive "Stop Forwarding Port" and can silently deliver the auth code to a different container (it then logs *that* container in). Token auth has no callback to lose |
| rotation-tasks | one `mcp:secret:<name>` task per secret you'll actually rotate, besides the set-all `mcp:secrets` | rotation is the common case after day one; re-entering all of them invites paste errors |
| app-side-untasked | **Variant B:** deliberately no `mcp:*` task for the app side — the app deploys through its normal pipeline | the Taskfile boundary keeps who-owns-what visible |
| deploy-app-first | **Variant B:** sequence app-first when the Worker starts requiring something the app issues (see `variant-b-app-relay.md`) | new consents fail in the gap otherwise |

## Engine — copy faithfully

- `assets/Taskfile.mcp.yml` → merge into the root `Taskfile.yml`.
- `assets/mprocs.yaml` → `<app>-mcp/mprocs.yaml`.
- `assets/tsconfig.json` → `<app>-mcp/tsconfig.json` (standard strict Worker tsconfig; runtime types come from the generated `worker-configuration.d.ts`, not `@cloudflare/workers-types`).

## Shape — write fresh

**Provisioning: what legitimately sits outside version control** — all tool-managed, none belongs in TF state:

| Thing | Provisioned by | Why not TF |
|---|---|---|
| KV namespace id | `task mcp:kv-create` (after `account_id` is set — see `account-id-first`) → paste into `wrangler.jsonc` | one resource; the binding already lives there — TF would split creation across two tools |
| Secrets | `task mcp:secrets` (`wrangler secret put`) | the Cloudflare TF secret resource stores the value **in state**; wrangler keeps it out |
| IdP OAuth client (Variant A) | the IdP's console | e.g. Google's TF provider can't create general web OAuth clients |

**`.dev.vars.example`** — commit one (secrets *named*, values placeholder, one comment per secret saying where it comes from); copy to gitignored `.dev.vars` for `wrangler dev`. `wrangler types` types these too.

**Other calls to make explicitly, not by omission:**

- Hostname: `workers.dev` is fine until the endpoint is client-facing. A custom domain is deferred scope, not a hack.
- No staging is a legitimate call for an internal tool if the app already guards env mismatches — write that down rather than implying staging exists.
- `wrangler tail` (`task mcp:tail`) + `observability.enabled` is the audit trail — confirm the `[auth] OK/DENIED` lines actually appear there before calling auth done.

## Verify at latest

- **wrangler** — current major (reference builds on v4); flags/config keys churn.
- **mprocs / MCP Inspector** — both invoked via `bunx` at latest; Inspector CLI name has been stable but check.
