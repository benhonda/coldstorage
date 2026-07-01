# account-backend infra — Terragrunt root (centralized state + generated backend/provider).
# Convention (adpharm-stack `terraform.md`): `infra/` is a pure container; this is the
# `account-backend` component root. Sibling to infra/coldstorage — separate because
# coldstorage's own root.hcl deliberately opts OUT of the Vercel/DNS convention (it's a Mac
# daemon + storage buckets, not a web app). This IS the Vercel app in the monorepo, so it
# gets the full convention: Vercel project + OIDC AWS access + TF-owned env vars.
#
# State lives in the shared `terraform-state-sensitive` bucket (profile `pharmer`,
# ca-central-1), keyed per component + path — same team constants as infra/coldstorage.

locals {
  aws_profile  = "pharmer"
  aws_region   = "ca-central-1"
  project_name = "coldstorage-account-backend"
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
