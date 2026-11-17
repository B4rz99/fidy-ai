import type * as Sql from "effect/sql/SqlClient";
import { SqliteClient, layer } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, ManagedRuntime, type PlatformError, Predicate, Schema } from "effect";
import { SqlError } from "effect/sql";
import { Hex } from "effect/encoding";
import { digestBytes } from "../../secret-material/operations";
import type { StoreHistory, StoreMigration } from "./contract";

type Refusal =
  | "invalid_history"
  | "history_mismatch"
  | "layout_mismatch"
  | "attempt_refused"
  | "step_failed"
  | "metadata_unavailable";
class MigrationUnavailable extends Data.TaggedError("MigrationUnavailable")<{
  readonly reason: Refusal;
}> {}
const refuse = (reason: Refusal): Effect.Effect<never, MigrationUnavailable> =>
  Effect.fail(new MigrationUnavailable({ reason }));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const checksum = (data: unknown): Effect.Effect<string, PlatformError.PlatformError> =>
  digestBytes(new TextEncoder().encode(json(data))).pipe(Effect.map(Hex.encode));
const schemaCatalog = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const rows = yield* sql`SELECT type, name, sql FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA')
    AND NOT (name='__miniflare_do_name' AND sql='CREATE TABLE __miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)')
    AND name NOT IN ('store_migrations','store_migration_attempts')
    ORDER BY type,name`;
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({ type: Schema.String, name: Schema.String, sql: Schema.NullOr(Schema.String) })
    )
  )(rows);
});
const markers = Schema.Array(
  Schema.Struct({
    owner: Schema.String,
    version: Schema.Int,
    id: Schema.String,
    checksum: Schema.String,
    layout: Schema.String,
  })
);
const readProgress = Effect.fnUntraced(function* (
  history: StoreHistory,
  digests: ReadonlyArray<string>
) {
  const sql = yield* SqliteClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS store_migrations(owner TEXT NOT NULL,version INTEGER PRIMARY KEY CHECK(version>0),id TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,layout TEXT NOT NULL) STRICT`;
      yield* sql`CREATE TABLE IF NOT EXISTS store_migration_attempts(version INTEGER NOT NULL,release TEXT NOT NULL,attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),retry_at_ms INTEGER NOT NULL,terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),PRIMARY KEY(version,release)) STRICT`;
      const applied = yield* Schema.decodeUnknownEffect(markers)(
        yield* sql`SELECT owner,version,id,checksum,layout FROM store_migrations ORDER BY version LIMIT ${history.steps.length + 1}`
      );
      if (
        applied.some(
          (row, index) =>
            row.owner !== history.owner ||
            row.version !== index + 1 ||
            row.id !== history.steps[index]?.id ||
            row.checksum !== digests[index]
        )
      ) {
        return yield* refuse("history_mismatch");
      }
      const objects = yield* schemaCatalog;
      const latest = applied.at(-1);
      if (
        latest === undefined ? objects.length !== 0 : latest.layout !== (yield* checksum(objects))
      ) {
        return yield* refuse("layout_mismatch");
      }
      return applied.length;
    })
  );
});
const migrate = Effect.fnUntraced(function* (
  history: StoreHistory,
  step: StoreMigration,
  digest: string
) {
  const sql = yield* SqliteClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const statement of step.statements) {
        if (typeof statement === "string") yield* sql.unsafe(statement);
        else yield* sql.unsafe(statement.sql, statement.bindings);
      }
      const layout = yield* checksum(yield* schemaCatalog);
      yield* sql`INSERT INTO store_migrations(owner,version,id,checksum,layout) VALUES (${history.owner},${step.version},${step.id},${digest},${layout})`;
    })
  );
});
const firstRetryMs = 60_000;
const secondRetryMs = 300_000;
const activationLimitMs = 30_000;
const retryable = (error: unknown): boolean => {
  if (!SqlError.isSqlError(error)) return false;
  const cause = error.reason.cause;
  return (
    error.isRetryable ||
    (Predicate.hasProperty(cause, "retryable") && cause.retryable === true) ||
    (Predicate.hasProperty(cause, "overloaded") && cause.overloaded === true)
  );
};
const tryStep = Effect.fnUntraced(function* ({
  history,
  step,
  digest,
  release,
}: Readonly<{ history: StoreHistory; step: StoreMigration; digest: string; release: string }>) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  // A lost reply or crash cannot move the next attempt earlier than a full activation plus its delay.
  const claim =
    yield* sql.withTransaction(sql`INSERT INTO store_migration_attempts(version,release,attempts,retry_at_ms,terminal)
    VALUES(${step.version},${release},1,${now + activationLimitMs + firstRetryMs},0)
    ON CONFLICT(version,release) DO UPDATE SET attempts=attempts+1,retry_at_ms=${now + activationLimitMs + secondRetryMs}
    WHERE terminal=0 AND attempts<3 AND retry_at_ms<=${now}
    RETURNING attempts`);
  if (claim.length === 0) return yield* refuse("attempt_refused");
  const [attempt] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ attempts: Schema.Int })])
  )(claim);
  yield* migrate(history, step, digest).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const failedAt = yield* Clock.currentTimeMillis;
        yield* sql.withTransaction(sql`UPDATE store_migration_attempts
      SET terminal=${retryable(error) ? 0 : 1},retry_at_ms=${failedAt + (attempt.attempts === 1 ? firstRetryMs : secondRetryMs)}
      WHERE version=${step.version} AND release=${release} AND attempts=${attempt.attempts}`);
        return yield* refuse("step_failed");
      })
    )
  );
});
/** A constructor owns this gate. Reconstructing an object always checks the full retained prefix. */
export const openSqliteStore = Effect.fnUntraced(
  function* (history: StoreHistory, release: string) {
    if (
      release.length === 0 ||
      history.steps.length === 0 ||
      history.steps.some((step, index) => step.version !== index + 1)
    ) {
      return yield* refuse("invalid_history");
    }
    const digests = yield* Effect.forEach(history.steps, (step) =>
      checksum([history.owner, step.version, step.id, step.statements])
    );
    const completed = yield* readProgress(history, digests);
    for (const step of history.steps.slice(completed)) {
      const digest = digests[step.version - 1];
      if (digest === undefined) return yield* refuse("invalid_history");
      yield* tryStep({ history, step, digest, release });
    }
  },
  Effect.mapError((error) =>
    error instanceof MigrationUnavailable
      ? error
      : new MigrationUnavailable({ reason: "metadata_unavailable" })
  )
);
export const createStoreRuntime = (
  storage: DurableObjectStorage
): ManagedRuntime.ManagedRuntime<SqliteClient | Sql.SqlClient, never> =>
  ManagedRuntime.make(layer({ storage }));
