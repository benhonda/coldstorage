#!/usr/bin/env bash
# Print a REAL S3 key for one archived blob, so a diagnostic never asks a human to eyeball a hash and never
# guesses at the key layout. Optional $1 = a specific blobId; default = the first verified blob.
#
# **Read the key, never rebuild it.** Keys are `blobs/<cognito-identity-id>/<blobId>` and the identity id is
# only handed out at `authenticate` — so anything concatenating `blobs/` + a blob id produces a path outside
# the caller's own IAM prefix and earns a 403 that reads like a broken grant. The journal records the full
# key at upload and `RestoreEngine` reads it back: it is the SSOT, so ask it.
#
# Lives in a file rather than inline in the Taskfile because the heredoc it needs cannot be indented inside
# a YAML block scalar without ending the block.
set -euo pipefail
DATA_DIR="${COLDSTORE_DATA_DIR:-$HOME/Library/Application Support/ColdStorage}"

key="$(python3 - "$DATA_DIR" "${1:-}" <<'PY'
import sqlite3, sys, glob, os
root, want = sys.argv[1], sys.argv[2]
js = sorted(glob.glob(f"{root}/users/*/coldstore.sqlite"), key=os.path.getmtime, reverse=True)
if not js:
    print("ERR:no journal under " + root + "/users/ — sign in once (task ui:mac:live)"); raise SystemExit
try:
    # READ-ONLY: the daemon has this file open, and a diagnostic must never be able to write to the index
    # that IS the vault's tree.
    db = sqlite3.connect(f"file:{js[0]}?mode=ro", uri=True)
    row = (db.execute("SELECT s3Key FROM blobs WHERE id=?", (want,)).fetchone() if want
           else db.execute("SELECT s3Key FROM blobs WHERE status='verified' ORDER BY rowid LIMIT 1").fetchone())
except Exception as e:
    print(f"ERR:couldn't read {js[0]} — {e}"); raise SystemExit
if row: print(row[0])
elif want: print(f"ERR:blob '{want}' is not in {js[0]}")
else: print("ERR:no verified blob yet — deposit something and let a run finish, then re-run")
PY
)"
case "$key" in ERR:*) echo "${key#ERR:}" >&2; exit 1;; "") echo "no key resolved" >&2; exit 1;; esac
printf '%s\n' "$key"
