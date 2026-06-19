#!/usr/bin/env bash
# Idempotent Swift toolchain install via swiftly (Ubuntu aarch64/x86_64).
# Used by post-create.sh (on rebuild) and `task daemon:setup` (existing container).
set -uo pipefail

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
