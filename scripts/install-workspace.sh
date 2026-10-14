#!/usr/bin/env bash
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
if [[ "$actual" == 'c49f0c789514eb505fe63df1777141c06bea4c783c190118442833aff25b98a9' && "$(date -u +%Y-%m-%d)" < '2026-10-10' ]]; then
  printf 'Applying authorized, expiring release-age exception for the exact #1011 lock snapshot (carried forward from #969/#996/#973/#987).\n' >&2
  exec bun install --frozen-lockfile --minimum-release-age=0 "$@"
fi
exec bun install --frozen-lockfile "$@"
