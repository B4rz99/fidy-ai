#!/usr/bin/env bash
set -euo pipefail
case "${1-}" in 36|1000) ;; *) exit 2 ;; esac
report="apps/server/test-results/2261-fleet/$1"
mkdir -p "$report"
export TMPDIR
TMPDIR="$(mktemp -d)"
# Capture only this process's isolated persistence directory. GNU time reports CPU and maximum RSS.
(
  while true; do
    printf '%s\t%s\n' "$(date +%s)" "$(du -sk "$TMPDIR" | cut -f1)"
    sleep 10
  done
) > "$report/persistence-kib.tsv" &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true; rm -rf "$TMPDIR"' EXIT
status=0
/usr/bin/time -v -o "$report/runner-resources.txt" bun scripts/infra-performance/fleet/native.test-fixture.ts "$1" || status=$?
python3 scripts/infra-performance/fleet/coverage_report.py "$report"
exit "$status"
