# ColdStorage infra — Terragrunt root (centralized state + generated backend/provider).
# Convention (adpharm-stack `terraform.md`): `infra/` is a pure container; this is the
# `coldstorage` component root. State lives in a per-account bucket, keyed per component + path.
#
# Divergence from the reference (intentional, see infra/coldstorage/README.md): ColdStorage
# is a Mac daemon + storage buckets, NOT a Vercel web app. So there is no Vercel provider,
# no Vercel env vars, and no DNS/Route53 — `shared` is a near-empty placeholder kept only
# to satisfy the shared-first task surface.
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
  aws_region   = get_env("AWS_REGION")
  state_bucket = get_env("COLDSTORE_TF_STATE_BUCKET")
  project_name = "coldstorage"

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

  # Terraform is a DERIVED consumer of the reclaim constants, never a second source of them. Passed to
  # every stack; `shared` declares none of these variables and Terraform ignores the extra TF_VAR_s.
  reap_tag_key                 = local.reclaim.reapTagKey
  reap_tag_value               = local.reclaim.reapTagValue
  reclaimable_blob_expiry_days = local.reclaim.minimumStorageDays
}
