#!/usr/bin/env bash
set -euo pipefail

log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT

if NO_COLOR=1 bun ../../node_modules/alchemy/bin/alchemy.ts \
  drift --config alchemy-drift.run.ts --stage production --no-input >"$log_file" 2>&1; then
  drift_exit=0
else
  drift_exit=$?
fi

if ((drift_exit != 0)); then
  if grep --ignore-case --extended-regexp --quiet \
    '(ConfigError|MissingProviderConfig|missing (required )?(config|configuration))' "$log_file"; then
    category=configuration
  elif grep --ignore-case --extended-regexp --quiet \
    '(^|[^0-9])401([^0-9]|$)|unauthorized|invalid token|authentication' "$log_file"; then
    category=cloudflare_authentication
  elif grep --ignore-case --extended-regexp --quiet \
    '(^|[^0-9])403([^0-9]|$)|forbidden|permission denied' "$log_file"; then
    category=cloudflare_authorization
  elif grep --ignore-case --extended-regexp --quiet \
    '(^|[^0-9])429([^0-9]|$)|rate.?limit' "$log_file"; then
    category=cloudflare_rate_limited
  elif grep --ignore-case --extended-regexp --quiet \
    'timeout|timed out|fetch failed|ECONN|network error|(^|[^0-9])5[0-9][0-9]([^0-9]|$)' "$log_file"; then
    category=cloudflare_unavailable
  elif grep --ignore-case --extended-regexp --quiet \
    'state|bootstrap|lock' "$log_file"; then
    category=state
  else
    category=alchemy_failure
  fi

  printf 'Production Cloudflare topology drift inspection failed: category=%s exit=%d\n' \
    "$category" "$drift_exit" >&2
  exit 1
fi

if grep --fixed-strings --quiet 'Plan: no changes' "$log_file"; then
  echo 'Production Cloudflare topology has no drift.'
  exit 0
fi

if grep --fixed-strings --quiet 'Plan:' "$log_file"; then
  echo 'Production Cloudflare topology drift inspection failed: category=drift_detected' >&2
else
  echo 'Production Cloudflare topology drift inspection failed: category=missing_plan' >&2
fi

exit 1
