#!/bin/bash
set -e

# install psql (postgresql-client) (UNTESTED)
# gdb: debug wedged Swift processes (`gdb -p <pid> -batch -ex 'thread apply all bt'`). The toolchain's
# lldb is unusable here — it needs libpython3.12, which isn't in the repos (system is 3.14).
# libsodium-dev: the Swift core's Argon2id (swift-sodium's Linux systemLibrary target — see
# coldstorage/Package.swift, which pins the 0.9 line precisely so apt's build works). Without it
# `task daemon:build:dev` / `daemon:test` fail on a cold container, which is the loop this container
# exists to run.
sudo apt-get update && sudo apt-get install -y postgresql-client xdg-utils gdb libsodium-dev

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

# libsodium (Argon2id) — idempotent. The Taskfile said "the devcontainer post-create does it on rebuild"
# while post-create only ever installed Swift, so a cold container could not build or test the Swift core
# at all until someone happened to run `task daemon:setup` by hand. Same script the task runs.
bash "$(dirname "$0")/install-libsodium.sh"


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

