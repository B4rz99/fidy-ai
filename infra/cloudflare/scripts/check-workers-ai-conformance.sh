#!/usr/bin/env bash
set -euo pipefail

port="${WORKERS_AI_CONFORMANCE_PORT:-8799}"
model="${HOSTED_AI_MODEL:?HOSTED_AI_MODEL must select the approval candidate}"

# The promotion gate combines deterministic malformed-output/recovery evidence with the live model.
bun run --cwd ../../apps/server test:hosted-inference

config_file="$(mktemp)"
log_file="$(mktemp)"
response_file="$(mktemp)"
worker_pid=""

cat >"$config_file" <<EOF
{
  "name": "fidy-workers-ai-conformance",
  "main": "$(pwd)/../../apps/server/cloudflare/workers-ai-conformance-worker.ts",
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
  rm -f "$config_file" "$log_file" "$response_file"
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
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "Workers AI conformance Worker did not become ready." >&2
  exit 1
fi

if ! curl --silent --show-error --fail \
  --request POST \
  --output "$response_file" \
  "http://127.0.0.1:${port}/conformance"; then
  echo "The configured Workers AI model did not pass conformance." >&2
  exit 1
fi

if ! jq --exit-status \
  '. == {modelApprovalRevision: "workers-ai-2026-09-22", outcome: "conforming"}' \
  "$response_file" >/dev/null; then
  echo "The configured Workers AI model did not pass conformance." >&2
  exit 1
fi

echo "Workers AI model conformance passed."
