# ColdStorage infra — Terragrunt root (centralized state + generated backend/provider).
# Convention (adpharm-stack `terraform.md`): `infra/` is a pure container; this is the
# `coldstorage` component root. State lives in the shared `terraform-state-sensitive`
# bucket (profile `pharmer`, ca-central-1), keyed per component + path.
#
# Divergence from the reference (intentional, see infra/coldstorage/README.md): ColdStorage
# is a Mac daemon + storage buckets, NOT a Vercel web app. So there is no Vercel provider,
# no Vercel env vars, and no DNS/Route53 — `shared` is a near-empty placeholder kept only
# to satisfy the shared-first task surface. The team/state constants below ARE the convention.

locals {
  aws_profile  = "pharmer"
  aws_region   = "ca-central-1"
  project_name = "coldstorage"
}

# Centralized, encrypted remote state — one key per component/path.
remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }
  config = {
    bucket  = "terraform-state-sensitive"
    key     = "${local.project_name}/${path_relative_to_include()}/terraform.tfstate"
    region  = local.aws_region
    profile = local.aws_profile
    encrypt = true
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
      region  = "${local.aws_region}"
      profile = "${local.aws_profile}"

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
  aws_profile  = local.aws_profile
  aws_region   = local.aws_region
}
