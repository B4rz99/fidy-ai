#!/usr/bin/env bash
# Own the disposable database rather than accepting a development or production database URL.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-safety}"
case "$mode" in
  safety|smoke|baseline|test) ;;
  *) printf 'Evaluation refused: choose safety, smoke, baseline, or test.\n' >&2; exit 2 ;;
esac
if [[ "$mode" == baseline && "${FIDY_EVALUATION_APPROVE_FULL:-}" != synthetic-only ]]; then
  printf 'Full evaluation requires FIDY_EVALUATION_APPROVE_FULL=synthetic-only after reviewing the smoke cost.\n' >&2
  exit 2
fi
if [[ "$mode" == smoke || "$mode" == baseline ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    printf 'Evaluation unavailable: OPENAI_API_KEY is missing.\n' >&2
    exit 2
  fi
fi
container="fidy-evaluation-$(openssl rand -hex 8)"
password="$(openssl rand -hex 24)"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM
if ! docker run --detach --rm --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=fidy_evaluation --env "POSTGRES_PASSWORD=$password" postgres:18.6-alpine >/dev/null 2>&1; then
  printf 'Evaluation unavailable: disposable PostgreSQL could not start.\n' >&2; exit 2
fi
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$container" pg_isready -U postgres -d fidy_evaluation >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then printf 'Evaluation unavailable: PostgreSQL startup deadline.\n' >&2; exit 2; fi
port="$(docker port "$container" 5432/tcp)"
port="${port#127.0.0.1:}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then printf 'Evaluation refused: invalid local database binding.\n' >&2; exit 2; fi
export DATABASE_URL="postgresql://fidy_runtime:$password@127.0.0.1:$port/fidy_evaluation"
export MIGRATION_DATABASE_URL="postgresql://postgres:$password@127.0.0.1:$port/fidy_evaluation"
export EMAIL_ADMISSION_HMAC_KEY="$(openssl rand -hex 32)"
export EMAIL_CREDENTIAL_LOOKUP_HMAC_KEY="$(openssl rand -hex 32)"
export OPENAI_API_URL=https://api.openai.com/v1
export FIDY_EVALUATION_SOURCE_COMMIT="$(git rev-parse HEAD)"
if ! bun scripts/provision-runtime-role.ts >/dev/null 2>&1; then
  printf 'Evaluation unavailable: restricted role provisioning failed.\n' >&2; exit 2
fi
if [[ "$mode" == test ]]; then
  bun --bun vitest run --config vitest.config.ts --coverage.enabled=false src/shell/testing/evaluation/*.test.ts
else
  bun scripts/evaluate-es-co.ts "$mode"
fi
