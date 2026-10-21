#!/usr/bin/env bash
set -euo pipefail

allow_quota_deferral=false
if [[ "$#" == 1 && "$1" == --allow-quota-deferral ]]; then
  allow_quota_deferral=true
elif [[ "$#" != 0 ]]; then
  echo "Usage: check-workers-ai-conformance.sh [--allow-quota-deferral]" >&2
  exit 1
fi

port="${WORKERS_AI_CONFORMANCE_PORT:-8799}"
model="${HOSTED_AI_MODEL:?HOSTED_AI_MODEL must select the approval candidate}"

readonly readiness_connect_seconds=2 readiness_total_seconds=10
readonly conformance_connect_seconds=5
conformance_total_seconds="${WORKERS_AI_CONFORMANCE_TIMEOUT_SECONDS:-180}"
if [[ ! "$conformance_total_seconds" =~ ^[1-9][0-9]{0,2}$ ]] ||
  (( conformance_total_seconds > 180 )); then
  echo "Workers AI conformance timeout must be an integer from 1 to 180 seconds." >&2
  exit 1
fi
readonly conformance_total_seconds

bun run --cwd ../../apps/server test:hosted-inference

config_dir="$(mktemp -d)"
config_file="$config_dir/wrangler.jsonc"
log_file="$(mktemp)"
response_file="$(mktemp)"
worker_pid=""

cat >"$config_file" <<EOF
{
  "name": "fidy-workers-ai-conformance",
  "main": "$(pwd)/../../apps/server/cloudflare/ai/workers-ai-conformance-worker.ts",
  "compatibility_date": "2026-09-22",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI", "remote": true }
}
EOF

cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    for _settle_attempt in {1..60}; do
      if ! kill -0 "$worker_pid" 2>/dev/null; then break; fi
      sleep 0.05
    done
    kill -KILL "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$config_dir"
  rm -f "$log_file" "$response_file"
}
trap cleanup EXIT

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 "$root/scripts/cli-release/command.py" --timeout 300 -- wrangler dev \
  --config "$config_file" \
  --port "$port" \
  --var "HOSTED_AI_MODEL:$model" \
  >"$log_file" 2>&1 &
worker_pid="$!"

ready=false
for _attempt in $(seq 1 60); do
  if curl --silent --connect-timeout "$readiness_connect_seconds" \
    --max-time "$readiness_total_seconds" --output /dev/null "http://127.0.0.1:${port}/"; then
    ready=true
    break
  else
    curl_status=$?
    if [[ "$curl_status" == 28 ]]; then
      echo "Workers AI conformance readiness request timed out." >&2
      exit 1
    fi
  fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "Workers AI conformance Worker failed to start." >&2
    cat "$log_file" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "Workers AI conformance Worker did not become ready." >&2
  cat "$log_file" >&2
  exit 1
fi

if ! status=$(curl --silent \
  --connect-timeout "$conformance_connect_seconds" \
  --max-time "$conformance_total_seconds" \
  --max-filesize 1048576 \
  --request POST \
  --write-out '%{http_code}' \
  --output "$response_file" \
  "http://127.0.0.1:${port}/conformance"); then
  echo "Workers AI conformance request failed." >&2
  exit 1
fi

if [[ "$allow_quota_deferral" == true && "$status" == 503 ]] && jq --slurp --exit-status '
  length == 1 and (.[0] | .modelApprovalRevision == "workers-ai-gemma-4-2026-09-22"
    and .outcome == "non_conforming"
    and .category == "ProviderQuotaExceeded"
    and (.check | IN("canonical_query", "canonical_mutation", "canonical_mutation_money", "canonical_mutation_time", "canonical_correction", "canonical_deletion", "canonical_date_only", "canonical_recurring_lifecycle", "canonical_recurring_read", "invalid_output_recovery", "structured_es_co")))
' "$response_file" >/dev/null 2>&1; then
  check=$(jq --raw-output '.check' "$response_file")
  echo "::warning::Workers AI live conformance deferred: check=$check category=ProviderQuotaExceeded. Model behavior remains unverified; deterministic checks passed." >&2
  exit 0
fi

if [[ "$status" != 200 ]] || ! jq --exit-status \
  '. == {modelApprovalRevision: "workers-ai-gemma-4-2026-09-22", outcome: "conforming"}' \
  "$response_file" >/dev/null; then
  diagnostic=$(jq --slurp --raw-output '
    if length != 1 then "check=internal category=UnexpectedFailure"
    else .[0] | if .modelApprovalRevision == "workers-ai-gemma-4-2026-09-22"
      and .outcome == "non_conforming"
      and (.check | IN("configuration", "canonical_query", "canonical_mutation", "canonical_mutation_money", "canonical_mutation_time", "canonical_correction", "canonical_deletion", "canonical_date_only", "canonical_recurring_lifecycle", "canonical_recurring_read", "invalid_output_recovery", "structured_es_co", "internal"))
      and (.category | IN("InvalidAuthority", "CapacityExceeded", "ActiveRequestCapacityExceeded", "InvalidOutput", "ProviderUnavailable", "ProviderQuotaExceeded", "StructuredOutputExceeded", "StructuredOutputTimedOut", "UnexpectedFailure"))
    then "check=\(.check) category=\(.category)"
    else "check=internal category=UnexpectedFailure"
    end end
  ' "$response_file" 2>/dev/null || printf 'check=internal category=UnexpectedFailure')
  echo "Workers AI conformance failed: $diagnostic" >&2
  exit 1
fi

echo "Workers AI model conformance passed."
