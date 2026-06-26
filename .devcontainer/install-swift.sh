#!/usr/bin/env bash
# Idempotent Swift toolchain install via swiftly (Ubuntu aarch64/x86_64).
# Used by post-create.sh (on rebuild) and `task daemon:setup` (existing container).
set -uo pipefail

# System deps the Swift 6.3+ toolchain's post-install check requires, else it errors:
#   libpython3-dev → lldb / Swift REPL (pulls in the libpython3.12 runtime)
#   libz3-dev      → the SIL optimizer's Z3 backend
#   pkg-config     → resolving system-library module maps at build time
# Idempotent (dpkg -s gate); needs root via sudo, available in the devcontainer and on the daemon host.
SWIFT_DEPS="libpython3-dev libz3-dev pkg-config"
if ! dpkg -s $SWIFT_DEPS >/dev/null 2>&1; then
  sudo apt-get update -y && sudo apt-get install -y --no-install-recommends $SWIFT_DEPS
fi

if [ -x "$HOME/.local/share/swiftly/bin/swift" ] || command -v swift >/dev/null 2>&1; then
  echo "Swift already present: $("$HOME/.local/share/swiftly/bin/swift" --version 2>/dev/null | head -1)"
else
  cd /tmp
  ARCH=$(uname -m)
  curl -fsSLO "https://download.swift.org/swiftly/linux/swiftly-${ARCH}.tar.gz"
  tar zxf "swiftly-${ARCH}.tar.gz"
  ./swiftly init --assume-yes --skip-install
  . "$HOME/.local/share/swiftly/env.sh"
  swiftly install --assume-yes latest
  swiftly use latest
fi

# Wire the shell rc so `swift` is on PATH for interactive shells (and therefore `task`).
LINE='[ -f "$HOME/.local/share/swiftly/env.sh" ] && . "$HOME/.local/share/swiftly/env.sh"'
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
  touch "$rc"
  grep -qF 'swiftly/env.sh' "$rc" || printf '\n# Swift toolchain (swiftly)\n%s\n' "$LINE" >> "$rc"
done
