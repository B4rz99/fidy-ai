#!/usr/bin/env bash
set -euo pipefail

suffix="${GITHUB_RUN_ID:-local}-$$"
network="fidy-production-smoke-${suffix}"
database="fidy-production-smoke-db-${suffix}"
application="fidy-production-smoke-app-${suffix}"
image="fidy-production-smoke:${suffix}"
provisionLog=$(mktemp)

cleanup() {
  docker rm -f "$application" "${application}-rejected" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -f "$provisionLog"
}

assertProvisionRejected() {
  local runtimeUrl=$1
  local migrationUrl=$2
  local sentinel=$3

  if docker run --rm --network "$network" \
    --env "DATABASE_URL=${runtimeUrl}" --env "MIGRATION_DATABASE_URL=${migrationUrl}" \
    "$image" bun scripts/provision-runtime-role.ts >"$provisionLog" 2>&1; then
    echo "Runtime-role provisioning unexpectedly accepted an unsafe contract." >&2
    return 1
  fi
  if grep --fixed-strings --quiet "$sentinel" "$provisionLog"; then
    echo "Runtime-role provisioning leaked secret configuration." >&2
    return 1
  fi
}

assertProvisionRejectedWithoutConnection() {
  local before
  local after

  before=$(docker logs "$database" 2>&1 | grep --count "connection received" || true)
  assertProvisionRejected "$@"
  after=$(docker logs "$database" 2>&1 | grep --count "connection received" || true)
  if [[ "$after" != "$before" ]]; then
    echo "Invalid database configuration opened a PostgreSQL connection before rejection." >&2
    return 1
  fi
}

assertApplicationRejected() {
  local rejectedApplication="${application}-rejected"

  docker rm --force "$rejectedApplication" >/dev/null 2>&1 || true
  docker run --detach --name "$rejectedApplication" --network "$network" \
    --env MIGRATION_DATABASE_URL --env DATABASE_URL \
    --env KAPSO_API_KEY --env KAPSO_WEBHOOK_SECRET --env WHATSAPP_BUSINESS_PORTFOLIO_ID \
    --env OPENAI_API_KEY \
    --env SENTRY_DSN --env SENTRY_RELEASE --env SENTRY_ENVIRONMENT \
    --env PORT=3000 --env APP_VERSION=production-smoke-rejected \
    "$image" >/dev/null
  for _ in {1..20}; do
    if [[ $(docker inspect "$rejectedApplication" --format '{{.State.Running}}') == false ]]; then
      if [[ $(docker inspect "$rejectedApplication" --format '{{.State.ExitCode}}') == 0 ]]; then
        echo "Application exited successfully despite unsafe runtime authority." >&2
        return 1
      fi
      docker rm "$rejectedApplication" >/dev/null
      return 0
    fi
    sleep 0.5
  done

  docker logs "$rejectedApplication" >&2
  docker rm --force "$rejectedApplication" >/dev/null
  echo "Application started despite unsafe runtime authority." >&2
  return 1
}

assertRuntimePassword() {
  local password=$1
  docker run --rm --network "$network" postgres:18-alpine \
    psql "postgresql://fidy_runtime:${password}@${database}:5432/fidy" \
    --command "SELECT 1" >/dev/null
}

assertSqlResult() {
  local expected=$1
  local query=$2
  local label=$3
  local actual

  actual=$(docker exec "$database" psql --username fidy --dbname fidy \
    --tuples-only --no-align --command "$query" | tr -d '[:space:]')
  if [[ "$actual" != "$expected" ]]; then
    echo "${label}: expected '${expected}', received '${actual}'." >&2
    return 1
  fi
}
trap cleanup EXIT

docker build --tag "$image" .
docker network create "$network" >/dev/null
docker run --detach --name "$database" --network "$network" \
  --env POSTGRES_USER=fidy --env POSTGRES_PASSWORD=fidy --env POSTGRES_DB=fidy \
  postgres:18-alpine -c log_connections=on >/dev/null

for _ in {1..30}; do
  if docker exec "$database" pg_isready --username fidy --dbname fidy >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$database" pg_isready --username fidy --dbname fidy >/dev/null

export MIGRATION_DATABASE_URL="postgresql://fidy:fidy@${database}:5432/fidy"
export DATABASE_URL="postgresql://fidy_runtime:fidy_runtime@${database}:5432/fidy"
export KAPSO_API_KEY="production-smoke-kapso-key"
export KAPSO_WEBHOOK_SECRET="production-smoke-webhook-secret"
export WHATSAPP_BUSINESS_PORTFOLIO_ID="portfolio-production-smoke"
export OPENAI_API_KEY="production-smoke-openai-key"
export SENTRY_DSN="https://public@example.invalid/1"
export SENTRY_RELEASE="fidy@production-smoke"
export SENTRY_ENVIRONMENT="production-smoke"

assertProvisionRejected \
  "postgresql://fidy_runtime:runtime-sentinel@[bad/fidy" \
  "$MIGRATION_DATABASE_URL" \
  "runtime-sentinel"
assertProvisionRejected \
  "$DATABASE_URL" \
  "postgresql://fidy:migration-sentinel@[bad/fidy" \
  "migration-sentinel"
assertProvisionRejected \
  "postgresql://other:wrong-role@${database}:5432/fidy" \
  "$MIGRATION_DATABASE_URL" \
  "wrong-role"
assertProvisionRejected \
  "$DATABASE_URL" \
  "postgresql://fidy:fidy@${database}:5432/postgres" \
  "different-database"
assertProvisionRejected \
  "postgresql://fidy_runtime:runtime-no-database@${database}:5432" \
  "$MIGRATION_DATABASE_URL" \
  "runtime-no-database"
assertProvisionRejected \
  "$DATABASE_URL" \
  "postgresql://fidy:migration-no-database@${database}:5432" \
  "migration-no-database"
assertProvisionRejected \
  "${DATABASE_URL}?host=query-override-sentinel" \
  "$MIGRATION_DATABASE_URL" \
  "query-override-sentinel"
assertProvisionRejectedWithoutConnection \
  "$DATABASE_URL" \
  "postgresql://fidy:network-sentinel@unreachable.invalid:5432/fidy?host=${database}" \
  "network-sentinel"
assertSqlResult 0 \
  "SELECT count(*) FROM pg_roles WHERE rolname = 'fidy_runtime'" \
  "Rejected provisioning rollback"

docker run --rm --network "$network" \
  --env MIGRATION_DATABASE_URL --env DATABASE_URL \
  "$image" bun scripts/provision-runtime-role.ts
docker run --rm --network "$network" \
  --env MIGRATION_DATABASE_URL --env WHATSAPP_BUSINESS_PORTFOLIO_ID \
  "$image" bun scripts/migrate.ts
expectedMigrationCount=$(find src/shell/db/migrations -maxdepth 1 -type f \
  -name '[0-9][0-9][0-9][0-9]-*.ts' | wc -l | tr -d '[:space:]')
assertSqlResult "$expectedMigrationCount" \
  "SELECT count(*) FROM effect_sql_migrations" \
  "Pre-deploy migration count"

docker run --detach --name "$application" --network "$network" \
  --publish 127.0.0.1::3000 \
  --env MIGRATION_DATABASE_URL --env DATABASE_URL \
  --env KAPSO_API_KEY --env KAPSO_WEBHOOK_SECRET --env WHATSAPP_BUSINESS_PORTFOLIO_ID \
  --env OPENAI_API_KEY \
  --env SENTRY_DSN --env SENTRY_RELEASE --env SENTRY_ENVIRONMENT \
  --env PORT=3000 --env APP_VERSION=production-smoke \
  "$image" >/dev/null

port=$(docker inspect "$application" --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}')
origin="http://127.0.0.1:${port}"
for _ in {1..30}; do
  if curl --fail --silent --max-time 2 "${origin}/health" >/dev/null 2>&1; then
    break
  fi
  if ! docker inspect "$application" --format '{{.State.Running}}' | grep -qx true; then
    docker logs "$application" >&2
    exit 1
  fi
  sleep 1
done

bun scripts/check-deployment-smoke.ts "$origin"
assertSqlResult t \
  "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'fidy_runtime'" \
  "Runtime authority"
assertSqlResult f \
  "SELECT has_database_privilege('fidy_runtime', current_database(), 'CREATE') OR has_schema_privilege('fidy_runtime', 'public', 'CREATE')" \
  "Runtime schema authority"
assertSqlResult "$expectedMigrationCount" \
  "SELECT count(*) FROM effect_sql_migrations" \
  "Applied migration count"

unsafeRuntimeUrl="postgresql://fidy_runtime:replacement-sentinel@${database}:5432/fidy"
docker exec "$database" psql --username fidy --dbname fidy \
  --command "CREATE TABLE authority_probe (id integer); ALTER TABLE authority_probe OWNER TO fidy_runtime" \
  >/dev/null
assertProvisionRejected "$unsafeRuntimeUrl" "$MIGRATION_DATABASE_URL" "replacement-sentinel"
assertRuntimePassword fidy_runtime
docker exec "$database" psql --username fidy --dbname fidy \
  --command "ALTER TABLE authority_probe OWNER TO fidy; DROP TABLE authority_probe" >/dev/null

docker exec "$database" psql --username fidy --dbname fidy \
  --command "ALTER ROLE fidy_runtime SUPERUSER" >/dev/null
assertProvisionRejected "$unsafeRuntimeUrl" "$MIGRATION_DATABASE_URL" "replacement-sentinel"
assertRuntimePassword fidy_runtime
docker exec "$database" psql --username fidy --dbname fidy \
  --command "ALTER ROLE fidy_runtime NOSUPERUSER" >/dev/null

docker exec "$database" psql --username fidy --dbname fidy \
  --command "ALTER ROLE fidy_runtime BYPASSRLS" >/dev/null
assertProvisionRejected "$unsafeRuntimeUrl" "$MIGRATION_DATABASE_URL" "replacement-sentinel"
assertRuntimePassword fidy_runtime
docker exec "$database" psql --username fidy --dbname fidy \
  --command "ALTER ROLE fidy_runtime NOBYPASSRLS" >/dev/null

docker exec "$database" psql --username fidy --dbname fidy \
  --command "CREATE ROLE unsafe_runtime_parent SUPERUSER; GRANT unsafe_runtime_parent TO fidy_runtime" \
  >/dev/null
assertProvisionRejected "$unsafeRuntimeUrl" "$MIGRATION_DATABASE_URL" "replacement-sentinel"
assertRuntimePassword fidy_runtime
docker exec "$database" psql --username fidy --dbname fidy \
  --command "REVOKE unsafe_runtime_parent FROM fidy_runtime; DROP ROLE unsafe_runtime_parent" \
  >/dev/null

docker exec "$database" psql --username fidy --dbname fidy \
  --command "CREATE ROLE unsafe_runtime_parent; CREATE TABLE authority_probe (id integer); ALTER TABLE authority_probe OWNER TO unsafe_runtime_parent; GRANT unsafe_runtime_parent TO fidy_runtime" \
  >/dev/null
assertProvisionRejected "$unsafeRuntimeUrl" "$MIGRATION_DATABASE_URL" "replacement-sentinel"
assertRuntimePassword fidy_runtime
docker exec "$database" psql --username fidy --dbname fidy \
  --command "REVOKE unsafe_runtime_parent FROM fidy_runtime; ALTER TABLE authority_probe OWNER TO fidy; DROP TABLE authority_probe; DROP ROLE unsafe_runtime_parent" \
  >/dev/null

docker exec "$database" psql --username fidy --dbname fidy \
  --command "GRANT pg_execute_server_program TO fidy_runtime" >/dev/null
assertProvisionRejected "$unsafeRuntimeUrl" "$MIGRATION_DATABASE_URL" "replacement-sentinel"
assertRuntimePassword fidy_runtime
assertApplicationRejected
docker exec "$database" psql --username fidy --dbname fidy \
  --command "REVOKE pg_execute_server_program FROM fidy_runtime" >/dev/null

echo "Production image booted with all migrations and restricted runtime authority."
