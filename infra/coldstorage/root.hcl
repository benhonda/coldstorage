# ColdStorage infra — Terragrunt root (centralized state + generated backend/provider).
# Convention (adpharm-stack `terraform.md`): `infra/` is a pure container; this is the
# `coldstorage` component root. State lives in a per-account bucket, keyed per component + path.
#
# Divergence from the reference (intentional, see infra/coldstorage/README.md): ColdStorage
# is a Mac daemon + storage buckets, NOT a Vercel web app. So there are no Vercel env vars
# and no Route53 — `shared` is a near-empty placeholder kept only to satisfy the shared-first
# task surface.
#
# The Vercel provider IS pinned, for one narrow job: the two DNS records that point
# `auth.coldstorage.sh` at Cognito's managed login (modules/stack/auth-domain.tf). The zone lives in
# Vercel; both record values are computed by that plan, so they belong to Terraform. Nothing else
# here touches Vercel.
#
# ── WHERE THE ACCOUNT CONSTANTS COME FROM (changed 2026-07-27, see MIGRATION.md) ──────────────
# Region + state bucket are NOT written here. They are `get_env` reads of variables the root
# Taskfile exports — its `vars:` block is their single source of truth (PILLAR3), so moving this
# infra between AWS accounts touches one file, not five. The calls deliberately have NO default:
# run outside `task tf:*` they fail loudly instead of quietly planning against whatever account
# happens to be ambient. Run infra through the Taskfile (TP1).
#
# The AWS *profile* isn't read at all — the AWS provider and the S3 backend both honour the
# exported AWS_PROFILE natively, so naming it again here would only be a second place to forget.

locals {
  aws_region       = get_env("AWS_REGION")
  state_bucket     = get_env("COLDSTORE_TF_STATE_BUCKET")
  vercel_team_slug = get_env("COLDSTORE_VERCEL_TEAM_SLUG")
  vercel_token_ssm = get_env("COLDSTORE_VERCEL_TOKEN_SSM_PARAM")
  project_name     = "coldstorage"

  # Space reclamation's cross-component constants — see the root `reclaim.constants.json` for why they
  # live in one file. Decoded HERE rather than in each live stack so a second env cannot be stood up
  # with a different reap tag than the daemon writes. `get_repo_root()` errors outside a git checkout,
  # which is the correct failure: there is no plan worth running without these values.
  reclaim = jsondecode(file("${get_repo_root()}/reclaim.constants.json"))
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

# Generated provider + version pins — single source of truth across shared/stack/(future) staging.
# The `vercel` provider's `provider "vercel" {}` config block (api_token, team) lives in modules/stack
# (it reads an SSM parameter via a `data` source) — this just pins the version, matching infra/site.
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

    # Second AWS provider, pinned to N. Virginia — NOT a preference. A Cognito custom domain is served by
    # CloudFront, which is global and reads its certificate only from us-east-1, whatever region the user
    # pool lives in. Used by modules/stack/auth-domain.tf's ACM resources and nothing else.
    provider "aws" {
      alias  = "us_east_1"
      region = "us-east-1"

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

  # Vercel, for the auth-domain DNS records only (modules/stack/auth-domain.tf). Same reads as
  # infra/site — the Taskfile's `vars:` block is the SSOT for both. `shared` declares neither variable
  # and Terraform ignores the extra TF_VAR_s.
  vercel_team_slug       = local.vercel_team_slug
  vercel_token_ssm_param = local.vercel_token_ssm

  # Terraform is a DERIVED consumer of the reclaim constants, never a second source of them. Passed to
  # every stack; `shared` declares none of these variables and Terraform ignores the extra TF_VAR_s.
  reap_tag_key                 = local.reclaim.reapTagKey
  reap_tag_value               = local.reclaim.reapTagValue
  reclaimable_blob_expiry_days = local.reclaim.minimumStorageDays
}
