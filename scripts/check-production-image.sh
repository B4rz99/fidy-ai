#!/usr/bin/env bash
set -euo pipefail

suffix="${GITHUB_RUN_ID:-local}-$$"
network="fidy-production-smoke-${suffix}"
database="fidy-production-smoke-db-${suffix}"
application="fidy-production-smoke-app-${suffix}"
artifactContainer="fidy-production-smoke-artifact-${suffix}"
releaseContainer="fidy-production-smoke-release-${suffix}"
telemetryProbe="fidy-production-smoke-telemetry-${suffix}"
image="fidy-production-smoke:${suffix}"
provisionLog=$(mktemp)
artifactRoot=$(mktemp -d)
releaseRoot=$(mktemp -d)
releaseSha="0123456789abcdef0123456789abcdef01234567"
release="fidy@${releaseSha}"

cleanup() {
  docker rm -f "$application" "${application}-rejected" "$artifactContainer" \
    "$releaseContainer" "$telemetryProbe" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -f "$provisionLog"
  rm -rf "$artifactRoot" "$releaseRoot"
}

assertProvisionRejected() {
  local runtimeUrl=$1
  local migrationUrl=$2
  local sentinel=$3

  if docker run --rm --network "$network" \
    --env "DATABASE_URL=${runtimeUrl}" --env "MIGRATION_DATABASE_URL=${migrationUrl}" \
    "$image" bun dist/commands/provision-runtime-role.js >"$provisionLog" 2>&1; then
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
    --env "RAILWAY_GIT_COMMIT_SHA=${releaseSha}" \
    --env SENTRY_ENVIRONMENT --env SENTRY_CAPTURE_ERRORS --env SENTRY_CAPTURE_TRACES \
    --env SENTRY_PRODUCTION_DSN --env SENTRY_NON_PRODUCTION_DSN \
    --env SENTRY_RELEASE --env SENTRY_AUTH_TOKEN --env SENTRY_FORCE_ENV_TOKEN \
    --env SENTRY_ORG --env SENTRY_PROJECT --env SENTRY_URL \
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

inspectArtifacts() {
  docker create --name "$artifactContainer" "$image" >/dev/null
  docker cp "${artifactContainer}:/app/dist/." "$artifactRoot/"
  docker rm "$artifactContainer" >/dev/null

  if [[ $(find "$artifactRoot" -maxdepth 1 -type f -name '*.js' | wc -l | tr -d '[:space:]') != 2 ]]; then
    echo "The production image must contain exactly the built preload and application entries." >&2
    return 1
  fi
  if [[ ! -x "$artifactRoot/commands/sentry-cli" ]]; then
    echo "The runtime image is missing its pinned Sentry upload client." >&2
    return 1
  fi
  if ! grep --fixed-strings --quiet 'src/shell/observability/preload.ts' "$artifactRoot/preload.js.map" || \
    ! grep --fixed-strings --quiet 'src/main.ts' "$artifactRoot/main.js.map"; then
    echo "The production source maps do not cover the preload and application entries." >&2
    return 1
  fi
  if grep --recursive --quiet --binary-files=text --extended-regexp \
    'production-smoke-(kapso-key|webhook-secret|openai-key)|error-message-sentinel|financial-sentinel|secret-webhook-body-sentinel|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' \
    "$artifactRoot"; then
    echo "Production JavaScript or source maps contain a secret or synthetic fixture." >&2
    return 1
  fi
  if ! docker run --rm "$image" sh -c \
    'test ! -e src/main.ts && test ! -e src/shell/observability/preload.ts && test ! -e scripts/prepare-sentry-release.ts && test ! -e scripts/migrate.ts'; then
    echo "The runtime image retained direct TypeScript production entries." >&2
    return 1
  fi
}

assertRetentionStarted() {
  local applicationLogs=""

  for _ in {1..20}; do
    applicationLogs=$(docker logs "$application" 2>&1)
    if grep --fixed-strings --quiet 'Applied WhatsApp operational retention' <<<"$applicationLogs" && \
      grep --fixed-strings --quiet 'Applied AuditLogEntry retention' <<<"$applicationLogs" && \
      grep --fixed-strings --quiet 'Applied pending Consent retention' <<<"$applicationLogs"; then
      return 0
    fi
    sleep 0.5
  done

  docker logs "$application" >&2
  echo "The production retention workers did not report startup." >&2
  return 1
}

assertTelemetryDisabled() {
  sleep 1
  if docker logs "$telemetryProbe" 2>&1 | grep --fixed-strings --quiet 'sentry-transport-opened'; then
    echo "Disabled telemetry opened the Sentry transport." >&2
    return 1
  fi
}

assertReleasePreparation() {
  cat >"$releaseRoot/sentry-cli" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> /tmp/sentry-calls
EOF
  chmod 755 "$releaseRoot/sentry-cli"
  docker run --name "$releaseContainer" \
    --volume "$releaseRoot/sentry-cli:/app/dist/commands/sentry-cli:ro" \
    --env "RAILWAY_GIT_COMMIT_SHA=${releaseSha}" --env "SENTRY_RELEASE=${release}" \
    --env SENTRY_AUTH_TOKEN=upload-token-sentinel --env SENTRY_ORG=fidy-org \
    --env SENTRY_PROJECT=fidy-api \
    "$image" bun dist/commands/prepare-sentry-release.js
  docker cp "${releaseContainer}:/tmp/sentry-calls" "$releaseRoot/calls"
  docker rm "$releaseContainer" >/dev/null
  printf '%s\n' \
    "--url https://sentry.io/ releases new ${release}" \
    "--url https://sentry.io/ sourcemaps upload --release ${release} --validate --strict --wait-for 8 dist" \
    "--url https://sentry.io/ releases finalize ${release}" >"$releaseRoot/expected"
  if ! diff --unified "$releaseRoot/expected" "$releaseRoot/calls"; then
    echo "Release preparation did not create, upload, and finalize the image artifact in order." >&2
    return 1
  fi
}

assertCredentialsRemoved() {
  if ! docker exec "$application" sh -c '
    environment=$(tr "\0" "\n" </proc/1/environ)
    for name in SENTRY_AUTH_TOKEN SENTRY_FORCE_ENV_TOKEN SENTRY_ORG SENTRY_PROJECT SENTRY_URL SENTRY_NON_PRODUCTION_DSN; do
      if grep -q "^${name}=" <<EOF
${environment}
EOF
      then exit 1; fi
    done
    grep -q "^SENTRY_PRODUCTION_DSN=" <<EOF
${environment}
EOF
    grep -q "^SENTRY_RELEASE=fidy@[0-9a-f]\{40\}$" <<EOF
${environment}
EOF
  '; then
    echo "The production process retained upload authority or lost validated runtime telemetry configuration." >&2
    return 1
  fi
}
trap cleanup EXIT

docker build --tag "$image" .
inspectArtifacts
assertReleasePreparation

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
export SENTRY_ENVIRONMENT="production"
export SENTRY_CAPTURE_ERRORS="false"
export SENTRY_CAPTURE_TRACES="false"
export SENTRY_PRODUCTION_DSN="http://${telemetryProbe}:8080/1"
export SENTRY_NON_PRODUCTION_DSN="https://non-production-dsn-sentinel@example.invalid/2"
export SENTRY_RELEASE="$release"
export SENTRY_AUTH_TOKEN="upload-token-sentinel"
export SENTRY_FORCE_ENV_TOKEN="1"
export SENTRY_ORG="fidy-org"
export SENTRY_PROJECT="fidy-api"
export SENTRY_URL="https://sentry-upload-sentinel.invalid"

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
  "$image" bun dist/commands/provision-runtime-role.js
docker run --rm --network "$network" \
  --env MIGRATION_DATABASE_URL --env WHATSAPP_BUSINESS_PORTFOLIO_ID \
  "$image" bun dist/commands/migrate.js
expectedMigrationCount=$(find src/shell/db/migrations -maxdepth 1 -type f \
  -name '[0-9][0-9][0-9][0-9]-*.ts' | wc -l | tr -d '[:space:]')
assertSqlResult "$expectedMigrationCount" \
  "SELECT count(*) FROM effect_sql_migrations" \
  "Pre-deploy migration count"
docker exec "$database" psql --username fidy --dbname fidy \
  --command "INSERT INTO whatsapp_inbound_receipts (provider_message_id, delivery_key, status, claim_id, claim_expires_at, first_received_at, completed_at) VALUES ('wamid.text-001', 'production-smoke-delivery', 'completed', '00000000-0000-4000-8000-000000000112', now() + interval '1 minute', now(), now())" \
  >/dev/null

docker run --detach --name "$telemetryProbe" --network "$network" \
  "$image" bun -e \
  'Bun.serve({ port: 8080, fetch() { console.log("sentry-transport-opened"); return new Response(""); } });' \
  >/dev/null

docker run --detach --name "$application" --network "$network" \
  --publish 127.0.0.1::3000 \
  --env MIGRATION_DATABASE_URL --env DATABASE_URL \
  --env KAPSO_API_KEY --env KAPSO_WEBHOOK_SECRET --env WHATSAPP_BUSINESS_PORTFOLIO_ID \
  --env OPENAI_API_KEY \
  --env "RAILWAY_GIT_COMMIT_SHA=${releaseSha}" \
  --env SENTRY_ENVIRONMENT --env SENTRY_CAPTURE_ERRORS --env SENTRY_CAPTURE_TRACES \
  --env SENTRY_PRODUCTION_DSN --env SENTRY_NON_PRODUCTION_DSN \
  --env SENTRY_RELEASE --env SENTRY_AUTH_TOKEN --env SENTRY_FORCE_ENV_TOKEN \
  --env SENTRY_ORG --env SENTRY_PROJECT --env SENTRY_URL \
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
assertRetentionStarted
assertTelemetryDisabled
assertCredentialsRemoved
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
