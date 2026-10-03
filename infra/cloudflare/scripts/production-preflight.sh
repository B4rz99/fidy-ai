#!/usr/bin/env bash
set -euo pipefail

# Each lane owns a process group, including Bun, Vitest and Wrangler descendants.
set -m
cd "$(dirname "$0")/../../.."
log_dir="$(mktemp -d)"
pids=()
names=(worker-boundary workers-ai static-artifact cloudflare-state)

cleanup() {
  for pid in "${pids[@]}"; do
    if [[ -n "$pid" ]]; then kill -- "-$pid" 2>/dev/null || true; fi
  done
  for pid in "${pids[@]}"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$log_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

commands=(
  'bun run --cwd infra/cloudflare test -- workers.test.ts'
  'bun run --cwd infra/cloudflare test:workers-ai-conformance'
  'bun run --cwd apps/web build:production'
  'cd infra/cloudflare
   bun scripts/check-applied-migration-drift.ts
   bun ../../node_modules/alchemy/bin/alchemy.js provider cloudflare bootstrap --profile "$ALCHEMY_PROFILE" --no-input
   bash scripts/check-topology-drift.sh'
)

for index in "${!commands[@]}"; do
  bash -euo pipefail -c '
    SECONDS=0
    trap '\''printf "Preflight duration: %s %ss\n" "$1" "$SECONDS"'\'' EXIT
    bash -euo pipefail -c "$2"
  ' preflight "${names[$index]}" "${commands[$index]}" >"$log_dir/$index.log" 2>&1 &
  pids+=("$!")
done

# Drain every lane, even after a failure. No background gate may outlive this barrier.
failed=0
for index in "${!pids[@]}"; do
  if wait "${pids[$index]}"; then
    outcome=passed
  else
    outcome=failed
    failed=1
  fi
  pids[$index]=""
  printf '\n::group::Production preflight: %s (%s)\n' "${names[$index]}" "$outcome"
  cat "$log_dir/$index.log"
  printf '::endgroup::\n'
done
exit "$failed"
