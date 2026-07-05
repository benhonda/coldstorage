# Infrastructure — Terraform + Terragrunt (Vercel project scaffolding)

Scaffolds infra for an **already-existing, manually-created Vercel project**: centralized
Terragrunt **remote state**, **OIDC** AWS access, TF-**owned Vercel env vars**, and a
**Route53 DNS** record for a domain added manually in the Vercel dashboard — across one
environment or two (production ± staging), the end user's choice. Owns the env-var
ownership split that `env.md` links to. **TF never creates the Vercel project or binds
the domain to it** — both are manual, dashboard-side steps; TF only references
`vercel_project_id` and points a Route53 record at the CNAME target Vercel shows you.

**Scope:** Vercel-project setup only — state, env vars, OIDC, DNS. **Not** Lambda / ECS /
RDS / Step Functions / BunnyNet / shared VPCs — add a sibling root for those only when a
project genuinely needs one (KISS/YAGNI).

**Read when:** scaffolding infra, adding a second environment, or managing a project's
Vercel env vars / OIDC / DNS.

## Contract
- `infra/` is a pure **container** (no root config); each component is its own Terragrunt
  root — `infra/<component>/{root.hcl, live/{shared,<env>}, modules/{shared,stack}}`.
  `shared` = multi-tenant DNS zones; one stack per environment (`production`, optionally
  `staging`); `task tf:<component>:* ENV=…` plans/applies `shared` first, then the env
  (`references/taskfile.md` owns the commands). Scaffold one root per project; add sibling
  roots (`event-pipeline`, `cdn`, …) for separate concerns.
- Remote state is centralized in **`terraform-state-sensitive`** (profile `pharmer`,
  region `ca-central-1`), keyed per project/path; Terragrunt generates backend + provider.
- Vercel reaches AWS via an **OIDC role** (no stored keys); the role ARN is a TF-managed
  env var. Vercel env vars are **owned by Terraform**.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| env-tiers-default | **production + staging is the default — provision both unless the user explicitly opts into production-only.** staging is `infra/<component>/live/staging/` (a copy of `production` with `env="staging"`); both run via `task tf:<component>:* ENV=production\|staging` | don't make the user re-ask for staging every time; prod-only is the deliberate exception, not the baseline |
| layout | the `tf:<component>:*` tasks (below) **and** this layout are owned **here**: `infra/` is a pure container → each component root is `infra/<component>/{root.hcl,live/{shared,<env>},modules/{shared,stack}}`, `ENV=production\|staging`, shared planned first. **Always keep a `live/shared`** (the tasks plan it first) even if it only holds the Route53 zone | tasks + layout in one file → they can't drift |
| picker-when-multi | with **more than one component**, add bare `tf:plan`/`tf:apply` tasks that `select`-pick across component **and** env, dispatching to `tf:<component>:{plan,apply} ENV=…` — same `select`-picker idiom as `per-app-picker` in `references/taskfile.md`, not a second one — Shape below | one component → the per-component command is already short enough; >1 component → don't make the user memorize every `tf:<component>:*` name; one picker idiom everywhere (DRY) instead of a bespoke menu per domain |
| shared-vs-stack | **shared** = multi-tenant (Route53 hosted zones); **stack** (per-env) = the OIDC role, Vercel env vars, and the env's Route53 record | DNS zones are shared; everything env-specific is isolated per env |
| state-sensitive | state in S3 `terraform-state-sensitive` (encrypted), profile `pharmer`, region `ca-central-1`; Terragrunt generates `backend.tf`/`provider.tf` | shared, isolated team state |
| dependency-mock | env stacks read shared via a `dependency "shared"` block with `mock_outputs` | env `plan` runs before shared is applied |
| env-var-ownership | **TF-managed** = infra outputs (role ARN, region, bucket…), `sensitive = false`, overwritten each apply, `comment` = a static "TF-managed, do not edit" note; **manual secrets** = placeholders with `lifecycle { ignore_changes = [value, comment] }` (humans set the value in the dashboard, and may annotate the comment there too) — `comment` is sourced from `manual_secrets`'s map value (the var's purpose), since the resource never reads that value for anything else. Mark them `sensitive = true` **only on a prod-with-staging stack** (`target = ["production"]`); any stack whose targets include `preview`/`development` must stay `sensitive = false`, because **Vercel can't `vercel env pull` sensitive vars** (→ would force a separate dev copy). So **prod-only → secrets are non-sensitive; flag the user** their values are readable/pullable (acceptable, not a deal-breaker). Production stack → `target = ["production"]` **when staging exists**, else (prod-only) all three `["production","preview","development"]` (= Vercel's **"All Environments"**); staging stack → a `vercel_custom_environment` (branch-tracked) + `target = ["preview","development"]` | one owner for deployed env vars; devs `vercel env pull` the development target for local dev and sensitive vars don't come down. Prod-only must still feed preview/dev deploys, so it covers all targets. Every new key must also land in the app's zod schema — `deployed-vars-tf` in `references/env.md`. Comments matter most for manual secrets: whoever fills the value in blind, in the dashboard, needs to know what it is — ignore-changes keeps TF from clobbering it every apply |
| oidc-not-keys | Vercel→AWS via an OIDC role (`oidc.vercel.com/<team>` trust, env-scoped `sub`); expose `aws_iam_role.vercel.arn` as the TF-managed `AWS_ROLE_ARN` | no long-lived AWS keys |
| dns-zones-vs-records | the **root domain is the hosted zone** (usually pre-existing → import via `data`, in shared); subdomains are **records** (per-env, in stack) — a plain `aws_route53_record`, **no `vercel_project_domain`**: the domain is added to the Vercel project manually, in the dashboard, not by TF. The CNAME target is **per-project** — Vercel shows it once you add the domain there. **Ask the user for it**, don't default to `cname.vercel-dns.com` (Vercel routes regional projects to a project-specific target and warns against the generic one) | don't make a zone per subdomain; wrong CNAME target = broken/slow routing; domains/projects are manual, dashboard-owned, not TF-owned |
| never-apply | verify with `task tf:<component>:plan ENV=…` (a clean plan is "done"); the **never-`apply`** rule is a global guardrail → SKILL.md, and IAM ALLOW-only → `references/aws-oidc.md` | this row owns only the terraform-local verify command; both prohibitions live once, elsewhere |
| team-constants | `pharmer` / `ca-central-1` / `terraform-state-sensitive` are fixed; Vercel API token = SSM Parameter Store **`/adpharm/vercel-api-token-benhonda`**. Team slug is a per-project input | team facts, not guessable |

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
  has_staging = true   # default; set false for a prod-only project → prod env vars also target preview+development
  # key = env var name; value = human-readable purpose → becomes the Vercel dashboard "comment"
  manual_secrets = { DATABASE_URL = "Postgres connection string (RDS)", SESSION_SECRET = "NextAuth session signing secret" }
}
# staging (default): copy this dir, set env="staging", subdomain="app-staging"
```
```hcl
# modules/stack/vercel-env-vars.tf — Terraform owns the env vars
# Vercel API token: shared SSM Parameter Store SecureString
data "aws_ssm_parameter" "vercel_token" { name = "/adpharm/vercel-api-token-benhonda" }
provider "vercel" {
  api_token = data.aws_ssm_parameter.vercel_token.value
  team      = var.vercel_team_slug
}
locals {
  tf_managed = { AWS_ROLE_ARN = aws_iam_role.vercel.arn, AWS_REGION = var.aws_region }  # from outputs
  is_prod    = var.env == "production"
  # prod-only (no staging) → prod stack must cover all Vercel targets, else preview/dev deploys get no env vars
  targets    = local.is_prod ? (var.has_staging ? ["production"] : ["production", "preview", "development"]) : ["preview", "development"]
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
resource "vercel_project_environment_variable" "manual" {
  for_each = var.manual_secrets   # key = env var name; value = purpose, becomes the dashboard comment
  project_id = var.vercel_project_id; key = each.key; value = "SET_IN_VERCEL_DASHBOARD"; comment = each.value
  # sensitive ONLY when targets are exactly ["production"] (prod + staging); preview/development must stay
  # non-sensitive — `vercel env pull` can't fetch sensitive vars. Prod-only ⇒ false (flag the user).
  sensitive              = local.is_prod && var.has_staging
  target                 = local.targets
  custom_environment_ids = local.is_prod ? null : [vercel_custom_environment.env[0].id]
  lifecycle { ignore_changes = [value, comment] }     # never clobber the human-set value or dashboard comment
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

## Deploy
`task tf:<component>:plan ENV=production` (plans shared then the env) → review → user runs
`task tf:<component>:apply ENV=production`. For two envs, repeat with `ENV=staging`. Set manual-secret values in the
Vercel dashboard after first apply. Commands live in `references/taskfile.md`.

## Tasks — append to the project Taskfile (core lives in `references/taskfile.md`)
Namespace every component's tasks `tf:<component>:*` (e.g. `tf:pipeline:*`); `dir` is that
component's root. `deps: [check-aws-identity]` references the core's identity gate.
`ENV=production|staging`; every command plans/applies `shared` first.
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
With **more than one component**, add bare pickers (`picker-when-multi` above) — one `select`
per component+env pair, same idiom as `link`/`pull` in `references/taskfile.md`:
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
- **Terraform, Terragrunt, AWS + Vercel providers** — current versions on the Registry; use
  `~>`; confirm current schemas (`vercel_project_environment_variable`,
  `vercel_custom_environment`, `aws_iam_openid_connect_provider`).
