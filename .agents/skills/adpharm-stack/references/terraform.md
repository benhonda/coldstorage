# Infrastructure — Terraform + Terragrunt (Vercel project scaffolding)

Scaffolds infra for an **already-existing, manually-created Vercel project**: centralized Terragrunt **remote state**, **OIDC** AWS access, TF-**owned Vercel env vars**, and a **Route53 DNS** record for a domain added manually in the Vercel dashboard — across one environment or two (production ± staging), the end user's choice. Owns the env-var ownership split that `env.md` links to. **TF never creates the Vercel project or binds the domain to it** — both are manual, dashboard-side steps; TF only references `vercel_project_id` and points a Route53 record at the CNAME target Vercel shows you.

**Scope:** Vercel-project setup only — state, env vars, OIDC, DNS. **Not** Lambda / ECS / RDS / Step Functions / BunnyNet / shared VPCs — add a sibling root for those only when a project genuinely needs one (KISS/YAGNI).

**Read when:** scaffolding infra, adding a second environment, or managing a project's Vercel env vars / OIDC / DNS.

## Contract
- `infra/` is a pure **container** (no root config); each component is its own Terragrunt root — `infra/<component>/{root.hcl, live/{shared,<env>}, modules/{shared,stack}}`. `shared` = multi-tenant DNS zones; one stack per environment (`production`, optionally `staging`); `task tf:<component>:* ENV=…` plans/applies `shared` first, then the env (`references/taskfile.md` owns the commands). Scaffold one root per project; add sibling roots (`event-pipeline`, `cdn`, …) for separate concerns.
- Remote state is centralized **per AWS account** — each account has its own state bucket (Adpharm default: `terraform-state-sensitive`, profile `pharmer`, `ca-central-1`), keyed per project/path; Terragrunt generates backend + provider.
- Vercel reaches AWS via an **OIDC role** (no stored keys); the role ARN is a TF-managed env var. Vercel env vars are **owned by Terraform**.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| env-tiers-default | **production + staging is the default — provision both unless the user explicitly opts into production-only.** staging is `infra/<component>/live/staging/` (a copy of `production` with `env="staging"`); both run via `task tf:<component>:* ENV=production\|staging` | don't make the user re-ask for staging every time; prod-only is the deliberate exception, not the baseline |
| layout | the `tf:<component>:*` tasks (below) **and** this layout are owned **here**: `infra/` is a pure container → each component root is `infra/<component>/{root.hcl,live/{shared,<env>},modules/{shared,stack}}`, `ENV=production\|staging`, shared planned first. **Always keep a `live/shared`** (the tasks plan it first) even if it only holds the Route53 zone | tasks + layout in one file → they can't drift |
| picker-when-multi | with **more than one component**, add bare `tf:plan`/`tf:apply` tasks that `select`-pick across component **and** env, dispatching to `tf:<component>:{plan,apply} ENV=…` — same `select`-picker idiom as `per-app-picker` in `references/taskfile.md`, not a second one — Shape below | one component → the per-component command is already short enough; >1 component → don't make the user memorize every `tf:<component>:*` name; one picker idiom everywhere (DRY) instead of a bespoke menu per domain |
| shared-vs-stack | **shared** = multi-tenant (Route53 hosted zones); **stack** (per-env) = the OIDC role, Vercel env vars, and the env's Route53 record | DNS zones are shared; everything env-specific is isolated per env |
| state-sensitive | state in the target account's central S3 state bucket (encrypted; defaults → account-defaults row); Terragrunt generates `backend.tf`/`provider.tf` | shared, isolated team state |
| dependency-mock | env stacks read shared via a `dependency "shared"` block with `mock_outputs` | env `plan` runs before shared is applied |
| env-var-ownership | Every deployed env var is TF-owned, in one of two flavours. **Non-secrets** (role ARN, region, app URL, plain config): value lives in the TF source, `sensitive = false`, overwritten each apply, `comment` = a static "TF-managed, do not edit" note, `target` = the stack's full target set (prod-only ⇒ all three, `["production","preview","development"]` = Vercel's "All Environments"; with staging, prod takes `["production"]` and the staging stack owns `["preview","development"]`) so preview builds and `vercel env pull` both work. **Secrets**: value read from SSM (`env-vars-from-ssm`), `sensitive = true`, and the same targets **minus `development`** (`sensitive-not-development`). Never set a value by hand in the Vercel dashboard | one owner for deployed env vars, and one place a value can be read back from. Every new key must also land in the app's zod schema — `deployed-vars-tf` in `references/env.md` |
| sensitive-not-development | `sensitive = true` and the `development` target are **mutually exclusive** — Vercel rejects the combination outright: *"You cannot set a Sensitive Environment Variable's target to development."* Drop `development` from a secret's target list — whatever the non-secret set is — and let local dev read from SSM instead | a hard API constraint, not a preference; and it costs nothing, because `vercel env pull` never returns sensitive values anyway |
| env-vars-from-ssm | Secrets live in **SSM Parameter Store** (`/<name_prefix>/<kebab-key>`, SecureString) and TF carries them into the Vercel var write-only (`secrets-never-in-state`). Guard the ephemeral read with a `postcondition` refusing the placeholder, so an unset secret stops the apply rather than deploying a broken app. The Taskfile's `pull` writes them to `.env.secrets` for local dev (`per-app-picker` in `references/taskfile.md`). **Seed SSM before the first apply** that moves a project onto this model: that apply destroys the pre-existing Vercel variables, and TF has no ordering edge protecting a value that exists nowhere else | a sensitive Vercel var is write-only, so a secret kept only there is unrecoverable the moment it's marked sensitive — and one bad apply from gone |
| secrets-never-in-state | A secret must never reach state or a plan file, so **never `data "aws_ssm_parameter"` and never plain `value =`** — both persist cleartext. That also rules out `vercel_project_environment_variables` (**plural**) for secrets: it has no write-only variant, so its `variables` entries can only take `value`. Read with `ephemeral "aws_ssm_parameter"` (it keys off **`arn`**, not `name`) and write with `value_wo`, on the `aws_ssm_parameter` **and** the `vercel_project_environment_variable`. Pair every `value_wo` with a version or it never updates: `value_wo_version = aws_ssm_parameter.<x>.version` — SSM's own counter, which increments on every overwrite and refreshes unconditionally, so rotation propagates with no bookkeeping. It must come from the **managed** resource; the ephemeral one's `version` is rejected, since ephemerality propagates through expressions and version args are state-persisted. On the parameter itself use `value_wo = <placeholder>` + `value_wo_version = 1` + `lifecycle { ignore_changes = [value_wo_version] }` (this **replaces** `ignore_changes = [value]`). Name the parameter in a `postcondition` `error_message` from a local, never `self.name` — any ephemeral reference makes Terraform suppress the whole message. Floors: vercel provider **>= 5.9.0**, Terraform **>= 1.11**. Retrofitting a project that already ran on `value` → `retrofit-write-only` in Shape below | write-only args are the only way a secret crosses TF without being persisted; and because they can never produce a diff on their own, a missing version arg fails silently — the rotated secret simply never ships |
| cron-secret-is-vercel-owned | A project with Vercel crons **must** carry `CRON_SECRET` as a Vercel project env var — the platform reads that exact key itself and sends it as `Authorization: Bearer …` when it invokes the job. It is still SSM-backed like any other secret (TF writes it in); what it can never be is resolved at runtime from somewhere else, because the caller is Vercel, not your code | the one env var the platform consumes rather than your app — move it and every cron 401s, with no error anywhere pointing at the cause |
| oidc-not-keys | Vercel→AWS via an OIDC role (`oidc.vercel.com/<team>` trust, env-scoped `sub`); expose `aws_iam_role.vercel.arn` as the TF-managed `AWS_ROLE_ARN` | no long-lived AWS keys |
| dns-zones-vs-records | the **root domain is the hosted zone** (usually pre-existing → import via `data`, in shared); subdomains are **records** (per-env, in stack) — a plain `aws_route53_record`, **no `vercel_project_domain`**: the domain is added to the Vercel project manually, in the dashboard, not by TF. The CNAME target is **per-project** — Vercel shows it once you add the domain there. **Ask the user for it**, don't default to `cname.vercel-dns.com` (Vercel routes regional projects to a project-specific target and warns against the generic one) | don't make a zone per subdomain; wrong CNAME target = broken/slow routing; domains/projects are manual, dashboard-owned, not TF-owned |
| never-apply | verify with `task tf:<component>:plan ENV=…` (a clean plan is "done"); the **never-`apply`** rule is a global guardrail → SKILL.md, and IAM ALLOW-only → `references/aws-oidc.md` | this row owns only the terraform-local verify command; both prohibitions live once, elsewhere |
| account-defaults | `pharmer` / `ca-central-1` / `terraform-state-sensitive` / Vercel token at SSM **`/adpharm/vercel-api-token-benhonda`** are the **Adpharm-account defaults** — most projects, not all. Every AWS account has its **own state bucket + SSO profile** (+ token param); for a non-Adpharm account get all four from the user or the repo's existing config (account rule: `references/aws-oidc.md`). Team slug is a per-project input | account facts — not guessable, and not universal |

## Layout (matches the Taskfile)
```
infra/                              # pure container — NO root config; one sibling Terragrunt root per component
└── <component>/                    # e.g. silo-lens, event-pipeline — own root.hcl + own state prefix
    ├── root.hcl                    # root: state + generated backend/provider (Terragrunt root config)
    ├── live/
    │   ├── shared/terragrunt.hcl       # → modules/shared (Route53 zones)
    │   ├── production/terragrunt.hcl   # → modules/stack (env="production")
    │   └── staging/terragrunt.hcl      # second env (env="staging") — default; omit only for prod-only projects
    └── modules/
        ├── shared/                 # hosted zones + outputs (zone ids)
        └── stack/                  # OIDC role, Vercel env vars, Route53 record (domain added to Vercel manually)
# a root with >1 Vercel project nests them: live/projects/<name>/<env> + modules/<name>
```

## Shape — write fresh, verify provider resource names (illustration, not gospel)
```hcl
# infra/<component>/root.hcl (root) — centralized state + generated provider
locals { aws_profile = "pharmer"; aws_region = "ca-central-1"; project_name = "my-project" }
remote_state {
  backend = "s3"; generate = { path = "backend.tf", if_exists = "overwrite" }
  config = { bucket = "terraform-state-sensitive",
    key = "${local.project_name}/${path_relative_to_include()}/terraform.tfstate",
    region = local.aws_region, profile = local.aws_profile, encrypt = true }
}
inputs = { project_name = local.project_name, aws_profile = local.aws_profile, aws_region = local.aws_region }
```
```hcl
# infra/<component>/live/production/terragrunt.hcl — an env stack reading shared
terraform { source = "../../modules/stack" }
include "root" { path = find_in_parent_folders("root.hcl") }
dependency "shared" {
  config_path  = "../shared"
  mock_outputs = { root_zone_id = "Z123MOCK" }   # lets `plan` run before shared is applied
}
inputs = {
  env = "production"; vercel_project_id = "prj_…"; vercel_team_slug = "adpharm"
  root_zone_id = dependency.shared.outputs.root_zone_id; subdomain = "app"
  has_staging = true   # default; set false for a prod-only project
  name_prefix = "my-project-production"   # SSM path prefix holding this project's secrets
  # key = env var name; value = human-readable purpose → becomes the Vercel comment
  secret_env_vars = { DATABASE_URL = "Postgres connection string", SESSION_SECRET = "Signs the session cookie" }
}
# staging (default): copy this dir, set env="staging", subdomain="app-staging"
```
```hcl
# modules/stack/vercel-env-vars.tf — Terraform owns the env vars
# Vercel API token: shared SSM SecureString. Ephemeral — a provider block is one of
# the few places an ephemeral value is allowed, and `data` would park a team-wide
# credential in state. No resource to take an ARN from, so compose it.
data "aws_caller_identity" "current" {}
ephemeral "aws_ssm_parameter" "vercel_token" {
  arn = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/adpharm/vercel-api-token-benhonda"
}
provider "vercel" {
  api_token = ephemeral.aws_ssm_parameter.vercel_token.value
  team      = var.vercel_team_slug
}
locals {
  tf_managed = { AWS_ROLE_ARN = aws_iam_role.vercel.arn, AWS_REGION = var.aws_region }  # from outputs
  is_prod    = var.env == "production"
  # prod-only (no staging) → prod stack must cover all Vercel targets, else preview/dev deploys get no env vars.
  # With staging, the staging stack owns preview+development, so prod must not claim them.
  targets    = local.is_prod ? (var.has_staging ? ["production"] : ["production", "preview", "development"]) : ["preview", "development"]
  # Secrets are the same set minus development — Vercel rejects sensitive there (sensitive-not-development).
  secret_targets = [for t in local.targets : t if t != "development"]
}
resource "vercel_custom_environment" "env" {           # only for non-production envs
  count = local.is_prod ? 0 : 1
  project_id = var.vercel_project_id; name = var.env
  branch_tracking = { pattern = var.env, type = "equals" }
}
resource "vercel_project_environment_variable" "managed" {
  for_each = local.tf_managed
  project_id = var.vercel_project_id; key = each.key; value = each.value; sensitive = false
  comment                 = "TF-managed — do not edit; value is overwritten on every apply"
  target                 = local.targets
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]
}
# Secrets: SSM is the readable source of truth; nothing below is ever persisted
# (secrets-never-in-state). TF owns each parameter's existence, humans own its value.
locals { ssm_names = { for k, _ in var.secret_env_vars : k => "/${var.name_prefix}/${replace(lower(k), "_", "-")}" } }
resource "aws_ssm_parameter" "secret" {
  for_each = var.secret_env_vars                      # key = env var name; value = human-readable purpose
  name     = local.ssm_names[each.key]; type = "SecureString"
  value_wo = "SET_ME_IN_SSM"; value_wo_version = 1    # placeholder written on create, never again
  lifecycle { ignore_changes = [value_wo_version] }
}
ephemeral "aws_ssm_parameter" "secret" {
  for_each = var.secret_env_vars
  arn      = aws_ssm_parameter.secret[each.key].arn   # `arn`, not `name`; defers the read until it exists
  lifecycle {
    postcondition {                                   # an unset secret stops the apply, not the app at boot
      condition = self.value != "SET_ME_IN_SSM"
      # local, NOT self.name — an ephemeral reference suppresses the whole message
      error_message = "SSM parameter ${local.ssm_names[each.key]} still holds the placeholder. Set it, then re-apply."
    }
  }
}
resource "vercel_project_environment_variable" "secret" {
  for_each = var.secret_env_vars
  project_id = var.vercel_project_id; key = each.key
  value_wo         = ephemeral.aws_ssm_parameter.secret[each.key].value
  value_wo_version = aws_ssm_parameter.secret[each.key].version   # SSM's counter drives rotation
  sensitive              = true
  target                 = local.secret_targets       # sensitive-not-development
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]
  # A sensitive var is write-only in Vercel, so the comment is the only thing a
  # human sees there — it must say where the real value lives.
  comment = "${each.value}. Value comes from AWS SSM ${local.ssm_names[each.key]} — edit it there and re-apply."
}
```
```hcl
# modules/stack/oidc.tf — Vercel assumes this AWS role (provider already exists in the account)
data "aws_iam_openid_connect_provider" "vercel" { url = "https://oidc.vercel.com/${var.vercel_team_slug}" }
resource "aws_iam_role" "vercel" {
  name = "${var.project_name}-${var.env}-vercel"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Federated = data.aws_iam_openid_connect_provider.vercel.arn },
    Action = "sts:AssumeRoleWithWebIdentity",
    Condition = { StringLike = { "oidc.vercel.com/${var.vercel_team_slug}:sub" =
      "owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${var.env}" } } }] })
}
# modules/stack/route53.tf — subdomain record in the shared zone
# The domain itself is added to the Vercel project manually, in the dashboard (not TF) —
# that step is what produces var.vercel_cname_target below.
resource "aws_route53_record" "app" {
  # var.vercel_cname_target = the per-project CNAME Vercel showed when the domain was added
  # manually in the dashboard — ASK THE USER, don't hardcode cname.vercel-dns.com
  zone_id = var.root_zone_id; name = var.subdomain; type = "CNAME"; ttl = 300; records = [var.vercel_cname_target]
}
```

### retrofit-write-only — one-time, for a project that already applied with `value`
Those parameters hold cleartext in state and a refresh won't clear it; only a create/update carrying `value_wo` flips the provider's `has_value_wo` and drops the value. There is nothing to migrate *to*, so have each parameter write its **own current value back over itself** — a no-op in AWS, a real update to Terraform. Temporarily, in `aws_ssm_parameter "secret"`, drop the `lifecycle` block and swap the two write-only lines for:
```hcl
  value_wo         = ephemeral.aws_ssm_parameter.secret_current[each.key].value
  value_wo_version = 2   # any value ≠ what state holds; forces exactly one update

# ARN composed, NOT aws_ssm_parameter.secret[*].arn — that would make the resource
# depend on a read of itself and Terraform rejects the cycle.
ephemeral "aws_ssm_parameter" "secret_current" {
  for_each = var.secret_env_vars
  arn      = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_names[each.key]}"
}
```
Apply → **revert both edits** → apply once more. The second apply is not optional: the write-back bumps SSM's `version`, which is computed, so Terraform can't plan the dependent `value_wo_version` change on the Vercel vars in the same run — they settle on the next one. Revert is mandatory too: on a fresh account these parameters don't exist yet, so that read fails and the stack can never be bootstrapped.

## Deploy
`task tf:<component>:plan ENV=production` (plans shared then the env) → review → user runs `task tf:<component>:apply ENV=production`. For two envs, repeat with `ENV=staging`. Seed every SSM parameter in `secret_env_vars` **before** the first apply — the `postcondition` refuses placeholders, and on a project migrating onto this model the apply destroys the old Vercel-held values first. Commands live in `references/taskfile.md`.

## Tasks — append to the project Taskfile (core lives in `references/taskfile.md`)
Namespace every component's tasks `tf:<component>:*` (e.g. `tf:pipeline:*`); `dir` is that component's root. `deps: [check-aws-identity]` references the core's identity gate. `ENV=production|staging`; every command plans/applies `shared` first.
```yaml
tf:<component>:_validate-env:
  internal: true
  requires: { vars: [ENV] }
  cmds:
    - 'case "{{.ENV}}" in production|staging) ;; *) echo "ENV must be production|staging"; exit 1 ;; esac'

tf:<component>:plan:
  desc: Terragrunt plan (ENV=production|staging) — plans shared first
  requires: { vars: [ENV] }
  deps: [check-aws-identity]
  dir: infra/<component>/live/{{.ENV}}
  cmds:
    - task: tf:<component>:_validate-env
    - task: tf:<component>:plan:shared
    - terragrunt plan {{.CLI_ARGS}}
tf:<component>:plan:shared:
  deps: [check-aws-identity]
  dir: infra/<component>/live/shared
  cmds:
    - terragrunt plan {{.CLI_ARGS}}

tf:<component>:apply:
  desc: Terragrunt apply (ENV=…) — applies shared then env
  interactive: true
  requires: { vars: [ENV] }
  deps: [check-aws-identity]
  dir: infra/<component>/live/{{.ENV}}
  cmds:
    - task: tf:<component>:_validate-env
    - task: tf:<component>:apply:shared
    - terragrunt apply {{.CLI_ARGS}}
tf:<component>:apply:shared:
  internal: true
  interactive: true
  dir: infra/<component>/live/shared
  cmds:
    - terragrunt apply {{.CLI_ARGS}}

tf:<component>:init:
  requires: { vars: [ENV] }
  deps: [check-aws-identity]
  dir: infra/<component>/live/{{.ENV}}
  cmds:
    - task: tf:<component>:_validate-env
    - terragrunt init {{.CLI_ARGS}}
tf:fmt:                          # repo-wide, no component/ENV
  cmds:
    - terraform fmt -recursive infra/
# tf:<component>:{destroy,import,list,refresh,output} follow the same ENV-scoped pattern.
```
With **more than one component**, add bare pickers (`picker-when-multi` above) — one `select` per component+env pair, same idiom as `link`/`pull` in `references/taskfile.md`:
```yaml
tf:plan:
  desc: Plan infra (interactive picker across components + envs)
  interactive: true
  silent: true
  cmds:
    - |
      echo "Plan which infra?"
      select target in "coldstorage:production" "account-backend:production" "account-backend:staging" quit; do
        case "$target" in
          coldstorage:production)     exec task tf:coldstorage:plan ENV=production ;;
          account-backend:production) exec task tf:account-backend:plan ENV=production ;;
          account-backend:staging)    exec task tf:account-backend:plan ENV=staging ;;
          quit) break ;;
        esac
      done

tf:apply:                        # never run without a reviewed plan — each target still confirms separately
  desc: Apply infra (interactive picker across components + envs)
  interactive: true
  silent: true
  cmds:
    - |
      echo "Apply which infra?"
      select target in "coldstorage:production" "account-backend:production" "account-backend:staging" quit; do
        case "$target" in
          coldstorage:production)     exec task tf:coldstorage:apply ENV=production ;;
          account-backend:production) exec task tf:account-backend:apply ENV=production ;;
          account-backend:staging)    exec task tf:account-backend:apply ENV=staging ;;
          quit) break ;;
        esac
      done
```

## Verify at latest
- **Terraform, Terragrunt, AWS + Vercel providers** — current versions on the Registry; use `~>`; confirm current schemas (`vercel_project_environment_variable`, `vercel_custom_environment`, `aws_iam_openid_connect_provider`). Mind the floors in `secrets-never-in-state`, and re-check that `value_wo`/`value_wo_version` still exist on the resources above — write-only support is recent and still spreading across resources.
