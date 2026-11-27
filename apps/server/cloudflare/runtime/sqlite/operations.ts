import type { UnknownError } from "effect/Cause";
import type * as Sql from "effect/sql/SqlClient";
import { SqliteClient, layer } from "@effect/sql-sqlite-do/SqliteClient";
import {
  Clock,
  Console,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Order,
  type PlatformError,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { Hex } from "effect/encoding";
import { digestBytes } from "../../secret-material/operations";
import {
  StoreCapacity,
  type StoreCapacityEvidence,
  StoreCapacityUnavailable,
  type StoreHistory,
  type StoreMigration,
} from "./contract";

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

const catalogEntry = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  sql: Schema.NullOr(Schema.String),
});

const schemaCatalog = Effect.gen(function* () {
  const sql = yield* SqliteClient;

  const rows = yield* sql`SELECT type, name, sql FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA')
    AND NOT (name='__miniflare_do_name' AND sql='CREATE TABLE __miniflare_do_name (id INTEGER PRIMARY KEY, name TEXT)')
    AND name NOT IN ('store_migrations','store_migration_attempts')`;

  const entries = yield* Schema.decodeUnknownEffect(Schema.Array(catalogEntry))(rows);
  const encoder = new TextEncoder();

  return entries
    .map((entry) => ({
      entry,
      utf8Key: Hex.encode(encoder.encode(`${entry.type}\0${entry.name}`)),
    }))
    .sort((left, right) => Order.String(left.utf8Key, right.utf8Key))
    .map(({ entry }) => entry);
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
      yield* Effect.forEach(
        step.statements,
        Effect.fnUntraced(function* (statement) {
          if (Predicate.isString(statement)) yield* sql.unsafe(statement);
          else yield* sql.unsafe(statement.sql, statement.bindings);
        }),
        { discard: true }
      );

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

const reportMigrationFailure = Effect.fnUntraced(function* (
  history: StoreHistory,
  release: string,
  error: MigrationUnavailable
) {
  const sql = yield* SqliteClient;

  const [attempt] =
    yield* sql`SELECT attempts,terminal FROM store_migration_attempts WHERE release=${release} AND version=(SELECT coalesce(max(version),0)+1 FROM store_migrations WHERE owner=${history.owner})`.pipe(
      Effect.orElseSucceed(() => [])
    );

  const critical =
    attempt?.terminal === 1 ||
    ["history_mismatch", "layout_mismatch", "invalid_history"].includes(error.reason);

  yield* Effect.logWarning({
    message: `fidy.operational component=sqlite operation=${history.owner} state=migration-failed severity=${critical ? "critical" : "warning"}`,
    reason: error.reason,
    attempts: attempt?.attempts ?? null,
  });
});

export const openSqliteStore = Effect.fnUntraced(
  function* (history: StoreHistory, release: string) {
    if (
      release.length === 0 ||
      history.steps.length === 0 ||
      history.steps.some((step, index) => step.version !== index + 1)
    ) {
      return yield* refuse("invalid_history");
    }

    const capacity = yield* StoreCapacity;
    yield* capacity.observe;

    const digests = yield* Effect.forEach(history.steps, (step) =>
      checksum([history.owner, step.version, step.id, step.statements])
    );

    const completed = yield* readProgress(history, digests);

    yield* Effect.forEach(
      history.steps.slice(completed),
      Effect.fnUntraced(function* (step) {
        const digest = digests[step.version - 1];

        if (digest === undefined) return yield* refuse("invalid_history");
        yield* tryStep({ history, step, digest, release });
      }),
      { discard: true }
    );

    yield* capacity.observe;
  },
  Effect.mapError((error) =>
    Schema.is(Schema.instanceOf(MigrationUnavailable))(error)
      ? error
      : new MigrationUnavailable({ reason: "metadata_unavailable" })
  ),
  (effect, history, release) =>
    effect.pipe(Effect.tapError((error) => reportMigrationFailure(history, release, error)))
);

const reportAlarm = Effect.fnUntraced(function* ({
  before,
  owner,
  repaired,
}: {
  before: Awaited<ReturnType<DurableObjectStorage["getAlarm"]>>;
  owner: StoreHistory["owner"];
  repaired: boolean;
}) {
  const now = yield* Clock.currentTimeMillis;

  if (repaired || (before !== null && before < now)) {
    let alarm = "rescheduled";

    if (before === null) alarm = "missing";
    else if (before < now) alarm = "overdue";
    yield* Effect.logInfo({
      message: `fidy.operational component=watchdog operation=${owner} state=alarm-${alarm} severity=${alarm === "missing" ? "warning" : "none"}`,
      overdueAgeMs: before === null ? null : Math.max(0, now - before),
    });
  }
});

const completedOwnerCheck = 204;

export const observeStoreCheck =
  ({
    storage,
    history,
    release,
  }: Readonly<{ storage: DurableObjectStorage; history: StoreHistory; release: string }>) =>
  <E, R>(
    work: Effect.Effect<Response, E, R>
  ): Effect.Effect<Response, E | StoreCapacityUnavailable | UnknownError, R | StoreCapacity> =>
    Effect.gen(function* () {
      const before = yield* Effect.tryPromise(() => storage.getAlarm());
      const response = yield* work;

      if (response.status !== completedOwnerCheck) return response;
      yield* reportAlarm({
        before,
        owner: history.owner,
        repaired: response.headers.get("fidy-alarm-repaired") === "1",
      });
      const capacity = yield* (yield* StoreCapacity).measure;
      response.headers.set("fidy-schema-version", String(history.steps.length));
      response.headers.set("fidy-storage-band", capacity.band);
      response.headers.set("fidy-schema-release", release);

      return response;
    });

const largestPlatformCeiling = 10_000_000_000;

const warningFraction = 0.7;

const restrictedFraction = 0.8;

const capacityBand = (bytes: number, ceiling: number): StoreCapacityEvidence["band"] => {
  if (bytes >= ceiling * restrictedFraction) return "restricted";

  if (bytes >= ceiling * warningFraction) return "warning";

  return "normal";
};

const makeCapacity = (
  storage: DurableObjectStorage,
  owner: StoreHistory["owner"],
  configured: string
): typeof StoreCapacity.Service => {
  const ceilingBytes = Number(configured);

  const valid =
    /^[1-9][0-9]*$/u.test(configured) &&
    Number.isSafeInteger(ceilingBytes) &&
    ceilingBytes <= largestPlatformCeiling;

  let previous: StoreCapacityEvidence["band"] = "normal";

  const measure = Effect.gen(function* () {
    if (!valid) return yield* new StoreCapacityUnavailable();

    const bytes = yield* Effect.try({
      try: () => storage.sql.databaseSize,
      catch: () => new StoreCapacityUnavailable(),
    });

    const band = capacityBand(bytes, ceilingBytes);

    return { owner, bytes, ceilingBytes, band };
  });

  const observe = Effect.gen(function* () {
    const evidence = yield* measure;
    const { band, bytes } = evidence;

    if (band !== previous) {
      previous = band;
      const log = { restricted: Console.error, warning: Console.warn, normal: Console.info }[band];
      yield* log(
        `fidy.sqlite_capacity owner=${owner} band=${band} bytes=${bytes} ceilingBytes=${ceilingBytes}`
      );
    }

    return evidence;
  });

  return { measure, observe };
};

export const withStoreAdmission = <Value, Failure, Requirements>(
  run: (
    admitGrowth: Effect.Effect<void, StoreCapacityUnavailable>
  ) => Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<
  Value,
  Failure | SqlError.SqlError | StoreCapacityUnavailable,
  Requirements | StoreCapacity | Sql.SqlClient
> =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    const capacity = yield* StoreCapacity;
    yield* capacity.observe;

    return yield* client
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* capacity.measure;
          const growth = yield* Ref.make(false);

          const admitGrowth = Effect.gen(function* () {
            if (before.band === "restricted") return yield* new StoreCapacityUnavailable();
            yield* Ref.set(growth, true);
          });

          const result = yield* run(admitGrowth);
          const after = yield* capacity.measure;

          if ((yield* Ref.get(growth)) && after.band === "restricted") {
            return yield* new StoreCapacityUnavailable();
          }

          if (after.bytes > after.ceilingBytes && after.bytes > before.bytes) {
            return yield* new StoreCapacityUnavailable();
          }

          return result;
        })
      )
      .pipe(Effect.tap(() => capacity.observe.pipe(Effect.ignore)));
  });

export const withStoreCapacity =
  (admission: "growth" | "required") =>
  <Value, Failure, Requirements>(
    work: Effect.Effect<Value, Failure, Requirements>
  ): Effect.Effect<
    Value,
    Failure | SqlError.SqlError | StoreCapacityUnavailable,
    Requirements | StoreCapacity | Sql.SqlClient
  > =>
    withStoreAdmission((admitGrowth) =>
      admission === "growth" ? Effect.andThen(admitGrowth, work) : work
    );

export const sqliteStoreLayer = ({
  storage,
  owner,
  ceilingBytes,
}: Readonly<{
  storage: DurableObjectStorage;
  owner: StoreHistory["owner"];
  ceilingBytes: string;
}>): Layer.Layer<SqliteClient | Sql.SqlClient | StoreCapacity> =>
  Layer.merge(
    layer({ storage }),
    Layer.succeed(StoreCapacity, makeCapacity(storage, owner, ceilingBytes))
  );

export const createStoreRuntime = (
  input: Parameters<typeof sqliteStoreLayer>[0]
): ManagedRuntime.ManagedRuntime<SqliteClient | Sql.SqlClient | StoreCapacity, never> =>
  ManagedRuntime.make(sqliteStoreLayer(input));

export const storeReadiness = Effect.fn(function* ({
  history,
  release,
}: {
  history: StoreHistory;
  release: string;
}) {
  const sql = yield* SqliteClient;

  const rows = yield* sql`SELECT checksum FROM store_migrations WHERE owner=${history.owner}
    ORDER BY version LIMIT ${history.steps.length + 1}`;

  const markers = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ checksum: Schema.String }))
  )(rows);

  if (markers.length !== history.steps.length) return new Response(null, { status: 503 });

  return Response.json({ workerVersionId: release, history: markers.map((row) => row.checksum) });
});

export const preserveStoreAlarm = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  instant: number
) {
  const earlier = yield* Effect.tryPromise(() => storage.getAlarm());

  if (earlier === null || instant < earlier) {
    yield* Effect.tryPromise(() => storage.setAlarm(instant));

    return true;
  }

  return false;
});
