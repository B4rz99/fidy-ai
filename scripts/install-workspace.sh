#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
install_arguments=(install --frozen-lockfile)
case "$*" in
  '') ;;
  --ignore-scripts) install_arguments+=(--ignore-scripts) ;;
  --cli-release) install_arguments+=(--production --ignore-scripts --filter @fidy/cli) ;;
  --server-tests) install_arguments+=(--filter @fidy/server) ;;
  --infra-tests) install_arguments+=(--filter @fidy/cloudflare-infra) ;;
  --unit-tests) install_arguments+=(--filter @fidy/server --filter @fidy/cli --filter @fidy/web) ;;
  *) printf 'Use --ignore-scripts, --cli-release, --server-tests, --infra-tests, or --unit-tests with the frozen workspace installer.\n' >&2; exit 2 ;;
esac
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum bun.lock | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 bun.lock | cut -d ' ' -f 1)"
fi
if [[ "$actual" == 'c49f0c789514eb505fe63df1777141c06bea4c783c190118442833aff25b98a9' && "$(date -u +%Y-%m-%d)" < '2026-10-10' ]]; then
  printf 'Applying authorized, expiring release-age exception for the exact #1011 lock snapshot (carried forward from #969/#996/#973/#987).\n' >&2
  exec bun "${install_arguments[@]}" --minimum-release-age=0
fi
exec bun "${install_arguments[@]}"
