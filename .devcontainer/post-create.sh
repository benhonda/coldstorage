#!/bin/bash
set -e

# install psql (postgresql-client) (UNTESTED)
# gdb: debug wedged Swift processes (`gdb -p <pid> -batch -ex 'thread apply all bt'`). The toolchain's
# lldb is unusable here — it needs libpython3.12, which isn't in the repos (system is 3.14).
sudo apt-get update && sudo apt-get install -y postgresql-client xdg-utils gdb

echo "Installing Bun"
curl -fsSL https://bun.sh/install | bash

# UI deps live in a named volume (see devcontainer.json mounts), so the container's Linux-native
# node_modules never collides with the macOS host's (the Mac runs the GUI via `task ui:mac:dev`). A fresh
# volume mounts as root-owned and empty — take ownership, then populate. Idempotent.
if [ -d /workspace/ui ]; then
  echo "Populating ui/node_modules (named volume)"
  sudo chown "$(id -u):$(id -g)" /workspace/ui/node_modules 2>/dev/null || true
  (cd /workspace/ui && "$HOME/.bun/bin/bun" install) || true
fi

# echo "Installing Claude CLI"
# ~/.bun/bin/bun add -g @anthropic-ai/claude-code

# Try to trust the package, but don't fail if it's already trusted or has no scripts
# echo "Trusting Claude CLI package (if needed)..."
# ~/.bun/bin/bun pm -g trust @anthropic-ai/claude-code 2>/dev/null || true

# Install Claude CLI
curl -fsSL https://claude.ai/install.sh | bash

# Swift toolchain (for the ColdStorage daemon) — idempotent
bash "$(dirname "$0")/install-swift.sh"

# MinIO + mc binaries (local S3 for daemon tests — no Docker)
ARCH=$(uname -m); case "$ARCH" in aarch64) MA=arm64 ;; x86_64) MA=amd64 ;; *) MA=arm64 ;; esac
sudo curl -fsSL "https://dl.min.io/server/minio/release/linux-${MA}/minio" -o /usr/local/bin/minio
sudo curl -fsSL "https://dl.min.io/client/mc/release/linux-${MA}/mc" -o /usr/local/bin/mc
sudo chmod +x /usr/local/bin/minio /usr/local/bin/mc

# Pre-commit leak guard: point git at the tracked .githooks/ dir (gitleaks scans staged
# changes on every commit). Idempotent; mirrors `task hooks:install`.
git -C /workspace config core.hooksPath .githooks

# echo "Running init-firewall.sh..."
# sudo /usr/local/bin/init-firewall.sh

# Playwright: OS-level apt deps (needs root) + browser binaries (must run as
# the invoking user so they land in ~/.cache/ms-playwright, where tests look —
# do NOT sudo the browser install or they go to /root and the runner can't find
# them). bunx, not npx: this is a bun workspace, only bunx resolves playwright.
# Browser list must match the matrix in playwright.config.ts / `task analytics:test:install`.
# sudo "$(which bunx)" playwright install-deps
# bunx playwright install chromium webkit

