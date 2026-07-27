# account-backend infra — Terragrunt root (centralized state + generated backend/provider).
# Convention (adpharm-stack `terraform.md`): `infra/` is a pure container; this is the
# `account-backend` component root. Sibling to infra/coldstorage — separate because
# coldstorage's own root.hcl deliberately opts OUT of the Vercel/DNS convention (it's a Mac
# daemon + storage buckets, not a web app). This IS the Vercel app in the monorepo, so it
# gets the full convention: Vercel project + OIDC AWS access + TF-owned env vars.
#
# State lives in a per-account bucket, keyed per component + path — same constants as the siblings.
#
# ── WHERE THE ACCOUNT CONSTANTS COME FROM (changed 2026-07-27, see MIGRATION.md) ──────────────
# Region, state bucket and the Vercel team slug are NOT written here. They are `get_env` reads of
# variables the root Taskfile exports — its `vars:` block is their single source of truth (PILLAR3),
# so moving this infra between AWS accounts (or Vercel teams) touches one file, not five. The calls
# deliberately have NO default: run outside `task tf:*` they fail loudly instead of quietly planning
# against whatever account happens to be ambient. Run infra through the Taskfile (TP1).
#
# The AWS *profile* isn't read at all — the AWS provider and the S3 backend both honour the exported
# AWS_PROFILE natively, so naming it again here would only be a second place to forget.

locals {
  aws_region       = get_env("AWS_REGION")
  state_bucket     = get_env("COLDSTORE_TF_STATE_BUCKET")
  vercel_team_slug = get_env("COLDSTORE_VERCEL_TEAM_SLUG")
  vercel_token_ssm = get_env("COLDSTORE_VERCEL_TOKEN_SSM_PARAM")
  project_name     = "coldstorage-account-backend"
}

# Centralized, encrypted remote state — one key per component/path. The bucket is NOT created on
# demand: Terragrunt 1.x made backend provisioning opt-in, so a fresh account needs `task tf:bootstrap`
# once before the first plan (older docs still describe the old auto-create behaviour).
remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }
  config = {
    bucket  = local.state_bucket
    key     = "${local.project_name}/${path_relative_to_include()}/terraform.tfstate"
    region  = local.aws_region
    encrypt = true
    # S3-native state locking (conditional writes). The old DynamoDB lock-table mechanism is deprecated
    # as of Terraform 1.11; this backend had NO locking at all before the account move, which was only
    # safe because exactly one person ever ran it. Free to turn on, so there's no reason not to.
    use_lockfile = true
  }
}

# Generated provider + version pins — single source of truth across shared/stack.
# The `vercel` provider's actual `provider "vercel" {}` config block (api_token, team) lives
# in modules/stack (it reads an SSM parameter via a `data` source, so it can't be generated
# here statically) — this just pins the required_providers version for it.
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite"
  contents  = <<-EOF
    terraform {
      required_version = ">= 1.9"
      required_providers {
        aws = {
          source  = "hashicorp/aws"
          version = "~> 6.51"
        }
        vercel = {
          source  = "vercel/vercel"
          version = "~> 3.0"
        }
      }
    }

    provider "aws" {
      region = "${local.aws_region}"

      default_tags {
        tags = {
          Project   = "${local.project_name}"
          ManagedBy = "terragrunt"
        }
      }
    }
  EOF
}

inputs = {
  project_name = local.project_name
  aws_region   = local.aws_region

  # Hoisted out of the four live/*/terragrunt.hcl files it used to be copy-pasted into (PILLAR3). It is
  # load-bearing, not a label: the slug is baked into the OIDC issuer URL AND the trust condition's `sub`
  # claim, so one stale copy yields a role nothing can assume — silently, until an AWS call fails.
  vercel_team_slug = local.vercel_team_slug

  # The Vercel API token's SSM parameter NAME (never its value). Account-scoped, so it moves with
  # the account rather than with this component — hence the Taskfile, not a literal in a module.
  vercel_token_ssm_param = local.vercel_token_ssm
}
