import { Config, Data, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { dashboardTransactionQueries } from "./internal/dashboard-query";

class ProjectionCostFailure extends Data.TaggedError("ProjectionCostFailure")<{ cause: unknown }> {}
const wait = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new ProjectionCostFailure({ cause }) }).pipe(
    Effect.orDie
  );
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000051";
const otherUserId = "10000000-0000-4000-8000-000000000052";
const categoryId = "10000000-0000-4000-8000-000000000001";
const transactionId = "20000000-0000-4000-8000-000000000001";
const migrationName = "0081_retire_projection_search.sql";
const migration = new URL(`../migrations/${migrationName}`, import.meta.url);
const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* wait(() => databases.acquire());
    yield* wait(() =>
      installTestSchema({
        db,
        sources: Array.from(
          new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
        )
          .sort()
          .filter((name) => name !== migrationName)
          .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
      })
    );
    yield* wait(() =>
      db.batch(
        [userId, otherUserId].flatMap((subject) => [
          db
            .prepare(
              "INSERT INTO users(id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
            )
            .bind(subject),
          db
            .prepare(
              "UPDATE dashboard_projection_state SET version = 1, readiness = 'ready' WHERE user_id = ?"
            )
            .bind(subject),
        ])
      )
    );
    return db;
  });

const capture = (db: D1Database, notes: string): Promise<D1Result> =>
  db
    .prepare(`INSERT INTO transactions(id, user_id, amount, currency, direction,
      counterparty, category_id, notes, occurred_at, created_at)
      VALUES (?, ?, '123.45', 'COP', 'outflow', 'Café', ?, ?,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    .bind(transactionId, userId, categoryId, notes)
    .run();
const correction = (db: D1Database, notes: string): Promise<D1Result[]> =>
  db.batch([
    db
      .prepare(`INSERT INTO transaction_corrections
      (id, user_id, transaction_id, previous_revision, changed_fields, before_facts, after_facts, corrected_at)
      VALUES ('correction', ?, ?, 0, '["notes"]', '{}', '{}', '2026-10-10T00:00:00.000Z')`)
      .bind(userId, transactionId),
    db
      .prepare(
        "UPDATE transactions SET notes = ?, revision = revision + 1, user_decisions = '{\"notes\":true}' WHERE user_id = ? AND id = ?"
      )
      .bind(notes, userId, transactionId),
  ]);
const search = (db: D1Database, text: string): Promise<D1Result[]> =>
  db.batch([
    ...dashboardTransactionQueries({
      db,
      userId,
      lists: [{ categories: [], search: Option.some(text), limit: 50 }],
    }),
  ]);
const snapshot = (db: D1Database): Promise<D1Result[]> =>
  db.batch(
    [
      "transactions",
      "dashboard_projection_leaf",
      "dashboard_projection_bucket",
      "dashboard_projection_digit",
    ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`))
  );
const Cost = Schema.Struct({ reads: Schema.Int, writes: Schema.Int, durationMs: Schema.Finite });
const Comparison = Schema.Struct({ before: Cost, after: Cost });
const measurementCodec = Schema.fromJsonString(
  Schema.Struct({
    scenario: Schema.Literal("projection-write"),
    length: Schema.Int,
    capture: Comparison,
    correction: Comparison,
  })
);
const costs = (results: ReadonlyArray<D1Result>): typeof Cost.Type =>
  results.reduce(
    (sum, result) => ({
      reads: sum.reads + result.meta.rows_read,
      writes: sum.writes + result.meta.rows_written,
      durationMs: sum.durationMs + result.meta.duration,
    }),
    { reads: 0, writes: 0, durationMs: 0 }
  );

it(
  "retires redundant search maintenance while preserving capture, Correction, search and exact aggregates",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const measuring = yield* Config.String("INFRA_PERFORMANCE_MEASURE").pipe(
          Config.withDefault("0")
        );
        for (const length of [32, 480, 1_024, 4_096]) {
          const before = yield* setup();
          const after = yield* setup();
          yield* wait(() => applyTestMigration({ db: after, source: migration }));
          const original = `Original café ${"x".repeat(length)}`;
          const replacement = `Replacement Ñandú ${"y".repeat(length)}`;
          const baselineCapture = yield* wait(() => capture(before, original));
          const candidateCapture = yield* wait(() => capture(after, original));
          expect(candidateCapture.meta.rows_read).toBeLessThan(baselineCapture.meta.rows_read);
          expect(candidateCapture.meta.rows_written).toBeLessThan(
            baselineCapture.meta.rows_written
          );
          expect((yield* wait(() => snapshot(after))).map((result) => result.results)).toEqual(
            (yield* wait(() => snapshot(before))).map((result) => result.results)
          );
          const baselineCorrection = yield* wait(() => correction(before, replacement));
          const candidateCorrection = yield* wait(() => correction(after, replacement));
          expect(costs(candidateCorrection).reads).toBeLessThan(costs(baselineCorrection).reads);
          expect(costs(candidateCorrection).writes).toBeLessThan(costs(baselineCorrection).writes);
          expect((yield* wait(() => snapshot(after))).map((result) => result.results)).toEqual(
            (yield* wait(() => snapshot(before))).map((result) => result.results)
          );
          for (const term of ["ÑANDÚ", "Replacement", "%", "Original", "missing"]) {
            expect(
              (yield* wait(() => search(after, term))).map((result) => result.results)
            ).toEqual((yield* wait(() => search(before, term))).map((result) => result.results));
          }
          expect((yield* wait(() => search(after, "ÑANDÚ")))[0]?.results).toHaveLength(1);
          if (measuring === "1") {
            const encoded = yield* Schema.encodeEffect(measurementCodec)({
              scenario: "projection-write" as const,
              length,
              capture: { before: costs([baselineCapture]), after: costs([candidateCapture]) },
              correction: { before: costs(baselineCorrection), after: costs(candidateCorrection) },
            });
            yield* Effect.sync(() => process.stdout.write(`INFRA_COST ${encoded}\n`));
          }
        }
      })
    ),
  30_000
);

it("upgrades populated projections without losing facts or allowing foreign search results", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* wait(() => capture(db, "Retained café"));
      yield* wait(() =>
        db
          .prepare(`INSERT INTO transactions
        SELECT '30000000-0000-4000-8000-000000000001', ?, amount, currency,
          direction, counterparty, category_id, 'Foreign café', occurred_at,
          created_at, revision, user_decisions FROM transactions WHERE id = ?`)
          .bind(otherUserId, transactionId)
          .run()
      );
      const retained = (yield* wait(() => snapshot(db))).map((result) => result.results);
      const previousSearch = (yield* wait(() => search(db, "café"))).map(
        (result) => result.results
      );
      yield* wait(() => applyTestMigration({ db, source: migration }));
      expect((yield* wait(() => snapshot(db))).map((result) => result.results)).toEqual(retained);
      expect((yield* wait(() => search(db, "café"))).map((result) => result.results)).toEqual(
        previousSearch
      );
      expect((yield* wait(() => search(db, "Foreign")))[0]?.results).toEqual([]);
      yield* wait(() => correction(db, "Replacement café"));
      expect((yield* wait(() => search(db, "Retained")))[0]?.results).toEqual([]);
      expect((yield* wait(() => search(db, "Replacement")))[0]?.results).toHaveLength(1);
      expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
    })
  ));
