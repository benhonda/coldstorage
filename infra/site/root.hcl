# site (marketing) infra — Terragrunt root (centralized state + generated backend/provider).
# Convention (adpharm-stack `terraform.md`): `infra/` is a pure container; this is the
# `site` component root — the marketing website's Vercel project. Sibling to
# infra/account-backend (the API) and infra/coldstorage (the Mac daemon + storage). Like
# account-backend it's a Vercel web app, so it gets the full convention: Vercel project +
# OIDC AWS access + TF-owned env vars. It is SIMPLER than account-backend — no Cognito, no
# database, no webhook secrets; its only app env vars are the two PUBLIC_PADDLE_* values the
# /checkout page needs.
#
# State lives in the shared `terraform-state-sensitive` bucket (profile `pharmer`,
# ca-central-1), keyed per component + path — same team constants as the siblings.

locals {
  aws_profile  = "pharmer"
  aws_region   = "ca-central-1"
  project_name = "coldstorage-site"
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
# The `vercel` provider's `provider "vercel" {}` config block (api_token, team) lives in
# modules/stack (it reads an SSM parameter via a `data` source) — this just pins the version.
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
