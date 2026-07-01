# Shared (cross-env) resources. Empty today — no DNS (see modules/shared/main.tf).
# Kept because the task surface plans `shared` first (matches infra/coldstorage's convention).
terraform {
  source = "../../modules/shared"
}

include "root" {
  path = find_in_parent_folders("root.hcl")
}
