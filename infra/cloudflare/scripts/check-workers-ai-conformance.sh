#!/usr/bin/env bash
set -euo pipefail

port="${WORKERS_AI_CONFORMANCE_PORT:-8799}"
model="${HOSTED_AI_MODEL:?HOSTED_AI_MODEL must select the approval candidate}"

# The promotion gate combines deterministic malformed-output/recovery evidence with the live model.
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
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$config_dir"
  rm -f "$log_file" "$response_file"
}
trap cleanup EXIT

wrangler dev \
  --config "$config_file" \
  --port "$port" \
  --var "HOSTED_AI_MODEL:$model" \
  >"$log_file" 2>&1 &
worker_pid="$!"

ready=false
for _attempt in $(seq 1 60); do
  if curl --silent --output /dev/null "http://127.0.0.1:${port}/"; then
    ready=true
    break
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

status=$(curl --silent --show-error \
  --request POST \
  --write-out '%{http_code}' \
  --output "$response_file" \
  "http://127.0.0.1:${port}/conformance")

if [[ "$status" != 200 ]] || ! jq --exit-status \
  '. == {modelApprovalRevision: "workers-ai-gemma-4-2026-09-22", outcome: "conforming"}' \
  "$response_file" >/dev/null; then
  diagnostic=$(jq --raw-output '
    if .modelApprovalRevision == "workers-ai-gemma-4-2026-09-22"
      and .outcome == "non_conforming"
      and (.check | IN("configuration", "canonical_query", "canonical_mutation", "canonical_mutation_money", "canonical_mutation_time", "invalid_output_recovery", "structured_es_co", "internal"))
      and (.category | IN("InvalidAuthority", "CapacityExceeded", "ActiveRequestCapacityExceeded", "InvalidOutput", "ProviderUnavailable", "StructuredOutputExceeded", "StructuredOutputTimedOut", "UnexpectedFailure"))
    then "check=\(.check) category=\(.category)"
    else "check=internal category=UnexpectedFailure"
    end
  ' "$response_file" 2>/dev/null || printf 'check=internal category=UnexpectedFailure')
  echo "Workers AI conformance failed: $diagnostic" >&2
  exit 1
fi

echo "Workers AI model conformance passed."
