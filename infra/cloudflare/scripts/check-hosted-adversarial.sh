#!/usr/bin/env bash
set -euo pipefail
umask 077

mode="${1:---dry-run}"
if [[ "$mode" != --dry-run && "$mode" != --live ]]; then
  echo 'Usage: check-hosted-adversarial.sh [--dry-run|--live]' >&2
  exit 1
fi
root="$(git rev-parse --show-toplevel)"
cd "$root"
if [[ "$mode" == --live && "${FIDY_APPROVE_ADVERSARIAL_SPEND:-}" != '65-calls-1040000-output-tokens' ]]; then
  echo 'Live evaluation needs explicit authorization: FIDY_APPROVE_ADVERSARIAL_SPEND=65-calls-1040000-output-tokens.' >&2
  exit 1
fi
if [[ "$mode" == --live && -n "$(git status --porcelain)" ]]; then
  echo 'Live evaluation requires a clean committed source tree for reproducible provenance.' >&2
  exit 1
fi
port=8798
model="$(bun infra/cloudflare/scripts/print-approved-workers-ai-model.ts)"
commit="$(git rev-parse HEAD)"
proof="$(mktemp -d "$root/.hosted-evaluation.XXXXXXXX")"
config="$proof/wrangler.jsonc"
worker_pid=''
cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    sleep 3
    kill -KILL "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$proof/.dev.vars" "$proof/curl.conf"
}
trap cleanup EXIT
# Capability is never placed on a command line or in a printable HTTP URL.
token="$(openssl rand -hex 32)"
printf 'EVALUATION_TOKEN="%s"\n' "$token" > "$proof/.dev.vars"
printf 'header = "Authorization: Bearer %s"\n' "$token" > "$proof/curl.conf"
unset token
jq -n --arg main "$root/apps/server/cloudflare/ai/workers-ai-evaluation-worker.ts" \
  --arg model "$model" --arg commit "$commit" --arg mode "${mode#--}" \
  '{name:"fidy-hosted-adversarial-local",main:$main,compatibility_date:"2026-09-22",compatibility_flags:["nodejs_compat"],vars:{HOSTED_AI_MODEL:$model,EVALUATION_COMMIT:$commit,EVALUATION_MODE:$mode},observability:{enabled:false}} + (if $mode == "live" then {ai:{binding:"AI",remote:true}} else {} end)' > "$config"
# Record actual local source bytes, including a dirty dry-run tree. No generated content goes to stdout.
git ls-files --cached --others --exclude-standard -z apps/server/src/shell/hosted-inference apps/server/cloudflare/ai apps/server/src/shell/canonical-operations apps/server/src/shell/api.ts apps/server/src/core/agent bun.lock infra/cloudflare/scripts/check-hosted-adversarial.sh \
  | xargs -0 shasum -a 256 > "$proof/source-sha256.txt"
python3 "$root/scripts/cli-release/command.py" --timeout 1320 -- bunx --no-install wrangler dev --config "$config" --ip 127.0.0.1 --port "$port" \
  --inspector-ip 127.0.0.1 --inspector-port 0 --show-interactive-dev-session=false \
  > "$proof/worker.log" 2>&1 &
worker_pid=$!
ready=false
for _attempt in $(seq 1 60); do
  if curl --noproxy '*' --silent --max-filesize 2097152 --config "$proof/curl.conf" --connect-timeout 1 --max-time 5 \
    --fail --output "$proof/manifest.json" "http://127.0.0.1:$port/manifest"; then
    ready=true
    break
  fi
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "Evaluation worker failed; private diagnostics: $proof/worker.log" >&2
    exit 1
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Evaluation readiness failed; no cases submitted.' >&2
  exit 1
fi
jq --exit-status --arg commit "$commit" --arg mode "${mode#--}" \
  '.commit == $commit and .mode == $mode and .limits.providerCalls == 65 and .limits.totalOutputTokens == 1040000 and .repetitions == 5' \
  "$proof/manifest.json" > /dev/null
jq '[.cases[] as $case | range(1; 6) | {caseId:$case.id,repetition:.,expected:$case.expected,grade:"pending",reviewer:null,evidence:null}]' "$proof/manifest.json" > "$proof/manual-review.json"
instance="$(jq -r '.instanceId' "$proof/manifest.json")"
started=$SECONDS
for index in $(seq 0 64); do
  if (( SECONDS - started >= 1200 )); then
    echo 'Evaluation wall-clock limit reached; do not retry this run.' >&2
    exit 1
  fi
  # No automatic retries: an interrupted HTTP exchange may already have purchased inference.
  status="$(curl --noproxy '*' --silent --max-filesize 2097152 --config "$proof/curl.conf" --connect-timeout 2 --max-time 125 \
    --request POST --write-out '%{http_code}' --output "$proof/case-$index.json" \
    "http://127.0.0.1:$port/evaluate/$index")" || {
      echo "Evaluation transport failed at index=$index; no retry. Evidence: $proof" >&2
      exit 1
    }
  jq --exit-status --arg instance "$instance" --argjson index "$index" \
    '.instanceId == $instance and .index == $index' "$proof/case-$index.json" > /dev/null
  if [[ "$status" != 200 ]]; then
    echo "Evaluation stopped at index=$index; private evidence: $proof" >&2
    exit 1
  fi
done
printf 'Evaluation captured 65 cases in mode=%s; semantic grading remains manual. Private evidence: %s\n' "${mode#--}" "$proof"
