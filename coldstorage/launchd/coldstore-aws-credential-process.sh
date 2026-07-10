#!/usr/bin/env bash
# AWS SDK `credential_process` provider — emits the daemon's IAM-user creds from the macOS
# login Keychain as the JSON the SDK expects. Referenced by the `coldstorage` profile in
# ~/.aws/config; resolved via aws-sdk-swift's default chain (profile → process). The secret
# lives ONLY in the Keychain (encrypted) — never in the plaintext plist or ~/.aws/credentials.
# Installed + Keychain seeded by `task daemon:mac:creds`.
set -euo pipefail

akid=$(security find-generic-password -s coldstorage-aws-access-key-id  -w 2>/dev/null) || {
  echo "coldstore creds: Keychain item 'coldstorage-aws-access-key-id' missing — run 'task daemon:mac:creds'" >&2; exit 1; }
secret=$(security find-generic-password -s coldstorage-aws-secret-access-key -w 2>/dev/null) || {
  echo "coldstore creds: Keychain item 'coldstorage-aws-secret-access-key' missing — run 'task daemon:mac:creds'" >&2; exit 1; }

# Static long-lived keys → no Expiration field (SDK treats them as non-expiring).
printf '{"Version":1,"AccessKeyId":"%s","SecretAccessKey":"%s"}\n' "$akid" "$secret"
