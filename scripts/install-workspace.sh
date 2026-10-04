#!/usr/bin/env bash
# User-authorized #969 exception, carried forward under #996 for Workers types only.
# This exact snapshot only; the original 2026-10-10 UTC expiry is unchanged.
# The ordinary seven-day policy remains in bunfig; changed locks receive no exception.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--ignore-scripts' ) ]]; then
  printf 'Only --ignore-scripts is accepted by the frozen workspace installer.\n' >&2
  exit 2
fi
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum bun.lock | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 bun.lock | cut -d ' ' -f 1)"
fi
if [[ "$actual" == '4bd4e37a9168d7eeff17772903f79f88edccb9c14caf5cedc22e14483119e876' && "$(date -u +%Y-%m-%d)" < '2026-10-10' ]]; then
  printf 'Applying authorized, expiring release-age exception for the exact #996 lock snapshot (carried forward from #969).\n' >&2
  exec bun install --frozen-lockfile --minimum-release-age=0 "$@"
fi
exec bun install --frozen-lockfile "$@"
