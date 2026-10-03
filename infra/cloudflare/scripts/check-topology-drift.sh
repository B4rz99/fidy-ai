#!/usr/bin/env bash
set -euo pipefail

log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT

if NO_COLOR=1 bun ../../node_modules/alchemy/bin/alchemy.js \
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
  # Never print a raw drift plan: attributes can contain Secret-backed values.
  resources=$(grep --extended-regexp --only-matching \
    '\[[[:alnum:]_-]+\] (create|update|replace|delete)' "$log_file" | sort -u || true)
  echo 'Production Cloudflare topology drift inspection failed: category=drift_detected' >&2
  # Take an additional dry-run snapshot for diagnostics only; never repair or change this verdict.
  bun inspect-worker-drift.ts >>"$log_file" 2>&1 || true
  # Emit only closed field names produced by the read-only field projector. Never values,
  # unknown keys, or raw provider lines, even when the inspection is not an explicit dispatch.
  grep --extended-regexp --only-matching \
    'Worker drift fields: (Core|Ingress) (accountId|workerId|workerName|namespace|logpush|url|urls|domain|tags|durableObjectNamespaces|routes|crons|tailConsumers|streamingTailConsumers|hash|affinityZoneIds|versionOf|versionId|deploymentId|other|unavailable)(,(accountId|workerId|workerName|namespace|logpush|url|urls|domain|tags|durableObjectNamespaces|routes|crons|tailConsumers|streamingTailConsumers|hash|affinityZoneIds|versionOf|versionId|deploymentId|other|unavailable))*$' \
    "$log_file" >&2 || true
  if [[ "${1:-}" == inspect ]]; then
    # Emit only allowlisted resource categories and whether other resources are involved.
    if [[ -z "$resources" ]]; then
      echo 'Drift resource categories: unavailable' >&2
    else
      if grep --quiet --extended-regexp '^\[Core\] ' <<< "$resources"; then
        echo 'Drift resource category: Core' >&2
      fi
      if grep --quiet --extended-regexp '^\[Ingress\] ' <<< "$resources"; then
        echo 'Drift resource category: Ingress' >&2
      fi
      if grep --quiet --extended-regexp -v '^\[(Core|Ingress)\] ' <<< "$resources"; then
        echo 'Drift resource category: other' >&2
      fi
    fi
  fi
else
  echo 'Production Cloudflare topology drift inspection failed: category=missing_plan' >&2
fi

exit 1
