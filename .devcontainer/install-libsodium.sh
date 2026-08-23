#!/bin/bash
# Idempotent libsodium install (Linux only) — the C library swift-sodium's Linux systemLibrary target
# links against for the Swift core's Argon2id (ZeroKnowledgeKeys; see PROD.md).
#
# NOT `apt install libsodium-dev`: Ubuntu 24.04 ships 1.0.18, which predates AEGIS (1.0.19) and the
# ipcrypt/KEM symbols (1.0.22) that swift-sodium's binding references — the build fails with
# "cannot find 'crypto_aead_aegis256_...' in scope". All of those live in tagged RELEASES, so this
# builds one from source rather than pinning the Swift package backwards.
#
# Apple platforms take swift-sodium's bundled XCFramework and never touch a system lib, so this is a
# no-op there — which is also why a missing libsodium is invisible from the Mac and only bites in the
# devcontainer, i.e. in `task daemon:build:dev` / `daemon:test`.
#
# Sibling of install-swift.sh, and called from the same two places for the same reason: the Taskfile
# (`task daemon:setup`) and post-create.sh, so one implementation serves both.
set -e

VERSION="${LIBSODIUM_VERSION:-1.0.22}"

[ "$(uname -s)" != "Linux" ] && { echo "libsodium: not Linux — swift-sodium bundles its own, nothing to do"; exit 0; }

if pkg-config --atleast-version=1.0.22 libsodium 2>/dev/null; then
  echo "libsodium already present: $(pkg-config --modversion libsodium)"
  exit 0
fi

echo "Installing libsodium ${VERSION} from source (apt's 1.0.18 is too old — see this script's header)"
cd /tmp
curl -fsSL "https://github.com/jedisct1/libsodium/releases/download/${VERSION}-RELEASE/libsodium-${VERSION}.tar.gz" -o libsodium.tar.gz
tar xzf libsodium.tar.gz
cd "libsodium-${VERSION}"
./configure --prefix=/usr/local
make -j"$(nproc)"
sudo make install
sudo ldconfig
cd /tmp && rm -rf libsodium.tar.gz "libsodium-${VERSION}"
echo "installed libsodium ${VERSION} to /usr/local"
