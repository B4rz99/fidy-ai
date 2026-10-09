import { Data, Effect, Option, Result } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";
import { sweepExpiredWorkersAiAdmission } from "../ai/runtime";
import { sweepExpiredEnrollmentAdmission } from "../subscription/runtime";
import { sweepExpiredUploadAdmission } from "../ingestion/runtime";

class TestDatabaseFailure extends Data.TaggedError("TestDatabaseFailure") {}
const fromPromise = <Value>(run: () => PromiseLike<Value>): Effect.Effect<Value> =>
  Effect.tryPromise({ try: run, catch: () => new TestDatabaseFailure() }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
type SweepFailure =
  | Effect.Error<ReturnType<typeof sweepExpiredWorkersAiAdmission>>
  | Effect.Error<ReturnType<typeof sweepExpiredEnrollmentAdmission>>
  | Effect.Error<ReturnType<typeof sweepExpiredUploadAdmission>>;
const owners: ReadonlyArray<
  Readonly<{
    prefix: string;
    sweep: (input: Readonly<{ db: D1Database; now: number }>) => Effect.Effect<void, SweepFailure>;
    window: number;
  }>
> = [
  { prefix: "workers-ai-", sweep: sweepExpiredWorkersAiAdmission, window: 86_400_000 },
  {
    prefix: "card-preparation-attempt-",
    sweep: sweepExpiredEnrollmentAdmission,
    window: 3_600_000,
  },
  { prefix: "ingestion-upload-", sweep: sweepExpiredUploadAdmission, window: 3_600_000 },
];
const prepareDatabase = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* fromPromise(() => databases.acquire());
    for (const name of ["0002_resource_admission", "0073_admission_retention"]) {
      yield* fromPromise(() =>
        applyTestMigration({ db, source: new URL(`../migrations/${name}.sql`, import.meta.url) })
      );
    }
    return db;
  });

// Seed real deferred-FK/claim-checked grants, without substituting admission or storage.
const seedGrants = (
  db: D1Database,
  {
    prefix,
    count,
    admitted,
    expires,
  }: Readonly<{ prefix: string; count: number; admitted: number; expires: number }>
): Effect.Effect<void> =>
  fromPromise(() =>
    db.batch([
      db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO resource_admission_events
      SELECT ?||i, 'test', 'operation', 'test', 'rolling_window', 1, ?, ?, ?, NULL FROM n`)
        .bind(count, prefix, admitted, admitted, expires),
      db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO resource_admission_grants SELECT ?||i, ?, 1 FROM n`)
        .bind(count, prefix, admitted),
    ])
  ).pipe(Effect.asVoid);

const observeReads = (db: D1Database): Readonly<{ database: D1Database; read: () => number }> => {
  let rowsRead = 0;
  return {
    database: {
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
      batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
        db.batch<Row>(statements).then((results) => {
          rowsRead += results.reduce((sum, result) => sum + result.meta.rows_read, 0);
          return results;
        }),
    },
    read: () => rowsRead,
  };
};
const countRows = (
  db: D1Database,
  table: "resource_admission_grants" | "resource_admission_events"
): Effect.Effect<number> =>
  fromPromise(() =>
    db.prepare(`SELECT count(*) AS count FROM ${table}`).first<number>("count")
  ).pipe(Effect.map((value) => Option.getOrThrow(Option.fromNullOr(value))));

it.each(owners)(
  "$prefix cleanup does not scan active or foreign grants",
  ({ prefix, sweep, window }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* prepareDatabase();
        yield* seedGrants(db, { prefix: "foreign-proof-", count: 2_000, admitted: 1, expires: 2 });
        yield* seedGrants(db, {
          prefix,
          count: 2_000,
          admitted: 100_000_000,
          expires: 100_000_000 + window,
        });
        const observed = observeReads(db);
        yield* sweep({ db: observed.database, now: 100_000_001 });
        expect(observed.read()).toBeLessThanOrEqual(10);
      })
    )
);

it.each(owners)(
  "$prefix cleanup drains expired evidence in bounded batches while preserving live and foreign grants",
  ({ prefix, sweep, window }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* prepareDatabase();
        const now = 100_000_000;
        yield* seedGrants(db, {
          prefix: `${prefix}expired-`,
          count: 2_000,
          admitted: now - window,
          expires: now,
        });
        yield* seedGrants(db, {
          prefix: `${prefix}live-`,
          count: 1,
          admitted: 1,
          expires: now + 60_000,
        });
        yield* seedGrants(db, { prefix: "foreign-proof-", count: 1, admitted: 1, expires: 2 });
        yield* seedGrants(db, { prefix: prefix.toUpperCase(), count: 1, admitted: 1, expires: 2 });
        yield* sweep({ db, now: now - 1 });
        expect(yield* countRows(db, "resource_admission_grants")).toBe(2_003);
        for (let tick = 0; tick < 16; tick += 1) {
          const observed = observeReads(db);
          yield* sweep({ db: observed.database, now });
          expect(observed.read()).toBeLessThanOrEqual(2_000);
          if (tick === 0) {
            expect(yield* countRows(db, "resource_admission_grants")).toBe(1_876);
            expect(yield* countRows(db, "resource_admission_events")).toBe(1_876);
          }
        }
        expect(yield* countRows(db, "resource_admission_grants")).toBe(3);
        expect(yield* countRows(db, "resource_admission_events")).toBe(3);
        yield* sweep({ db, now: now + 60_000 });
        expect(yield* countRows(db, "resource_admission_grants")).toBe(2);
        expect(yield* countRows(db, "resource_admission_events")).toBe(2);
      })
    )
);

it.each(owners)(
  "$prefix cleanup rolls back expired-event removal if grant deletion fails",
  ({ prefix, sweep, window }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* prepareDatabase();
        yield* seedGrants(db, { prefix, count: 1, admitted: 1, expires: 2 });
        yield* fromPromise(() =>
          db
            .prepare(`CREATE TRIGGER refuse_retention BEFORE DELETE ON resource_admission_grants
      BEGIN SELECT RAISE(ABORT, 'test_storage_failure'); END`)
            .run()
        );
        const result = yield* Effect.result(sweep({ db, now: window + 1 }));
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* countRows(db, "resource_admission_events")).toBe(1);
        expect(yield* countRows(db, "resource_admission_grants")).toBe(1);
      })
    )
);
