import { Data, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { effectiveTransactionRelation } from "./internal/effective-transaction";
import { findTransactionPresentation } from "./internal/transaction-history";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <Value>(run: () => PromiseLike<Value>): Effect.Effect<Value> =>
  Effect.tryPromise({
    try: run,
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000051";
const otherUserId = "10000000-0000-4000-8000-000000000052";
const categoryId = "10000000-0000-4000-8000-000000000016";
const prefix = "20000000-0000-4000-8000-";
const otherPrefix = "30000000-0000-4000-8000-";
const id = (index: number): string => `${prefix}${String(index).padStart(12, "0")}`;
const migration = new URL("../migrations/0075_transaction_query_costs.sql", import.meta.url);
const setup = (upgrade = false): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => databases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
    ).sort();
    yield* fromTestPromise(() =>
      installTestSchema({
        db,
        sources: names
          .filter((name) => !upgrade || name !== "0075_transaction_query_costs.sql")
          .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
      })
    );
    yield* fromTestPromise(() =>
      db.batch(
        [userId, otherUserId].map((subject) =>
          db
            .prepare(`INSERT INTO users(id, service_market, locale, time_zone, created_at_ms)
        VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)`)
            .bind(subject)
        )
      )
    );
    return db;
  });

// Suppress only per-row projection refresh during bulk arrangement. All measured operations run
// with the complete migrated trigger graph restored, including exact aggregate and FTS maintenance.
const seedHistory = (
  db: D1Database,
  {
    subject,
    transactionPrefix,
    count,
    linked,
  }: Readonly<{
    subject: string;
    transactionPrefix: string;
    count: number;
    linked: boolean;
  }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const triggers = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          sql: Schema.String,
        })
      )
    )(
      (yield* fromTestPromise(() =>
        db
          .prepare(`SELECT name, sql FROM sqlite_master WHERE name IN
    ('dashboard_projection_capture', 'dashboard_projection_link_member')`)
          .all()
      )).results
    ).pipe(Effect.orDie);
    yield* fromTestPromise(() =>
      db.batch(triggers.map((trigger) => db.prepare(`DROP TRIGGER ${trigger.name}`)))
    );
    yield* fromTestPromise(() =>
      db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO transactions(id, user_id, amount, currency, direction, counterparty,
      category_id, occurred_at, created_at)
    SELECT ? || printf('%012d', i), ?, '100', 'COP', 'outflow', 'shop', ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || (i * 20) || ' minutes'),
      strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || i || ' days') FROM n`)
        .bind(count, transactionPrefix, subject, categoryId)
        .run()
    );
    if (linked) {
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO transaction_reconciliation_decisions
      SELECT ?, ? || printf('%012d', 2 * i - 1), ? || printf('%012d', 2 * i),
        'linked', ? || printf('%012d', 2 * i - 1), '2026-01-01T00:00:00.000Z' FROM n`)
          .bind(count / 2, subject, transactionPrefix, transactionPrefix, transactionPrefix)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO transaction_reconciliation_members
      SELECT user_id, first_transaction_id, first_transaction_id, second_transaction_id
        FROM transaction_reconciliation_decisions WHERE user_id = ?
      UNION ALL SELECT user_id, second_transaction_id, first_transaction_id, second_transaction_id
        FROM transaction_reconciliation_decisions WHERE user_id = ?`)
          .bind(subject, subject)
          .run()
      );
    }
    yield* fromTestPromise(() => db.batch(triggers.map((trigger) => db.prepare(trigger.sql))));
    yield* fromTestPromise(() =>
      db.batch([
        db
          .prepare(
            "UPDATE dashboard_projection_state SET readiness = 'rebuilding' WHERE user_id = ?"
          )
          .bind(subject),
        db
          .prepare(`INSERT INTO dashboard_projection_leaf
      (user_id, id, amount, currency, direction, counterparty, category_id, notes,
        occurred_at, created_at, revision)
      SELECT user_id, id, amount, currency, direction, counterparty, category_id, notes,
        occurred_at, created_at, revision FROM dashboard_effective_source WHERE user_id = ?`)
          .bind(subject),
        db
          .prepare("UPDATE dashboard_projection_state SET readiness = 'ready' WHERE user_id = ?")
          .bind(subject),
      ])
    );
  });
const historyPage = (db: D1Database, subject: string): Promise<D1Result> => {
  const relation = effectiveTransactionRelation(subject);
  return db
    .prepare(`WITH ${relation.sql} SELECT * FROM effective_transaction
    WHERE user_id = ? ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT 101`)
    .bind(...relation.bindings, subject)
    .all();
};
it(
  "uses pair-member point reads without statistics and does not visit foreign Reconciliation pairs",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* seedHistory(db, {
          subject: userId,
          transactionPrefix: prefix,
          count: 2_000,
          linked: true,
        });
        const before = yield* fromTestPromise(() => historyPage(db, userId));
        expect(before.results).toHaveLength(101);
        expect(before.results[0]).toMatchObject({
          id: id(1_999),
          amount: "100",
        });
        expect(before.meta.rows_read).toBeLessThan(60_000);
        yield* seedHistory(db, {
          subject: otherUserId,
          transactionPrefix: otherPrefix,
          count: 2_000,
          linked: true,
        });
        for (const analyzed of [false, true]) {
          if (analyzed) yield* fromTestPromise(() => db.prepare("ANALYZE").run());
          const page = yield* fromTestPromise(() => historyPage(db, userId));
          expect(page.results).toEqual(before.results);
          expect(page.meta.rows_read).toBeLessThan(60_000);
          expect(page.meta.rows_read).toBeLessThanOrEqual(before.meta.rows_read + 10);
          const empty = yield* fromTestPromise(() =>
            db
              .prepare(`SELECT id, amount, currency, category_id, direction, occurred_at
      FROM dashboard_effective_source WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?
        AND category_id = ? AND currency = 'COP' AND direction = 'outflow'
        AND (occurred_at > ? OR (occurred_at = ? AND id > ''))
      ORDER BY occurred_at, id LIMIT 512`)
              .bind(
                userId,
                "2026-09-01T00:00:00.000Z",
                "2026-10-01T00:00:00.000Z",
                categoryId,
                "2026-09-01T00:00:00.000Z",
                "2026-09-01T00:00:00.000Z"
              )
              .all()
          );
          expect(empty.results).toEqual([]);
          expect(empty.meta.rows_read).toBeLessThan(25_000);
          expect(
            Option.isNone(
              yield* fromTestPromise(() =>
                findTransactionPresentation({
                  db,
                  userId: otherUserId,
                  id: id(1),
                })
              )
            )
          ).toBe(true);
        }
      })
    ),
  30_000
);
const correctNotes = (db: D1Database, index: number): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db
      .prepare(`INSERT INTO transaction_corrections
    (id, user_id, transaction_id, previous_revision, changed_fields, before_facts, after_facts, corrected_at)
    VALUES (?, ?, ?, 0, '["notes"]', '{}', '{}', '2026-10-09T00:00:00.000Z')`)
      .bind(`correction-${index}`, userId, id(index)),
    db
      .prepare(`UPDATE transactions SET notes = 'corrected', revision = 1, user_decisions = '{"notes":true}'
    WHERE user_id = ? AND id = ?`)
      .bind(userId, id(index)),
  ]);
const aggregateSnapshot = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db.prepare(
      "SELECT * FROM dashboard_projection_bucket ORDER BY user_id, size_seconds, bucket, currency, direction, category_id"
    ),
    db.prepare(
      "SELECT * FROM dashboard_projection_digit WHERE digit_sum > 0 ORDER BY user_id, size_seconds, bucket, currency, direction, category_id, position"
    ),
  ]);
it(
  "bounds Correction reads to the affected buckets and preserves exact aggregates and foreign rows",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* seedHistory(db, {
          subject: userId,
          transactionPrefix: prefix,
          count: 2_000,
          linked: false,
        });
        yield* seedHistory(db, {
          subject: otherUserId,
          transactionPrefix: otherPrefix,
          count: 2_000,
          linked: false,
        });
        const unlinkedPage = yield* fromTestPromise(() => historyPage(db, userId));
        expect(unlinkedPage.results).toHaveLength(101);
        expect(unlinkedPage.meta.rows_read).toBeLessThan(300);
        const before = (yield* fromTestPromise(() => aggregateSnapshot(db))).map(
          (result) => result.results
        );
        for (const index of [1, 2]) {
          if (index === 2) yield* fromTestPromise(() => db.prepare("ANALYZE").run());
          const corrected = yield* fromTestPromise(() => correctNotes(db, index));
          expect(corrected.reduce((sum, result) => sum + result.meta.rows_read, 0)).toBeLessThan(
            2_000
          );
          expect(
            (yield* fromTestPromise(() => aggregateSnapshot(db))).map((result) => result.results)
          ).toEqual(before);
          const own = Option.getOrThrow(
            yield* fromTestPromise(() =>
              findTransactionPresentation({
                db,
                userId,
                id: id(index),
              })
            )
          );
          expect(Option.getOrThrow(own.notes)).toBe("corrected");
          expect(own.revision).toBe(1);
          expect(
            yield* fromTestPromise(() =>
              db
                .prepare("SELECT notes FROM transactions WHERE user_id = ? AND id = ?")
                .bind(otherUserId, `${otherPrefix}${String(index).padStart(12, "0")}`)
                .first("notes")
            )
          ).toBeNull();
        }
        const refused = yield* fromTestPromise(() =>
          db
            .prepare("DELETE FROM transactions WHERE user_id = ? AND id = ?")
            .bind(otherUserId, id(3))
            .run()
        );
        expect(refused.meta.changes).toBe(0);
        const deleted = yield* fromTestPromise(() =>
          db
            .prepare("DELETE FROM transactions WHERE user_id = ? AND id = ?")
            .bind(userId, id(3))
            .run()
        );
        expect(deleted.meta.rows_read).toBeLessThan(1_000);
        expect(
          yield* fromTestPromise(() =>
            db
              .prepare(
                "SELECT SUM(count) AS count FROM dashboard_projection_bucket WHERE user_id = ? AND size_seconds = 86400"
              )
              .bind(userId)
              .first("count")
          )
        ).toBe(1_999);
        expect(
          yield* fromTestPromise(() =>
            db
              .prepare(
                "SELECT SUM(count) AS count FROM dashboard_projection_bucket WHERE user_id = ? AND size_seconds = 86400"
              )
              .bind(otherUserId)
              .first("count")
          )
        ).toBe(2_000);
        expect(
          (yield* fromTestPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
      })
    ),
  30_000
);
it("upgrades populated projection buckets without changing pre-epoch boundaries or exact maximum replacement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup(true);
      const dates = [
        "1969-12-31T23:57:59.999Z",
        "1969-12-31T23:58:00.000Z",
        "1969-12-31T23:58:00.001Z",
        "1969-12-31T23:59:00.000Z",
        "1969-12-31T23:59:01.000Z",
        "1969-12-31T23:59:59.999Z",
        "1970-01-01T00:00:00.000Z",
        "1970-01-01T00:00:59.999Z",
        "1970-01-01T00:01:00.000Z",
        "1970-01-01T00:01:00.001Z",
        "1970-01-01T23:59:59.999Z",
        "1970-01-02T00:00:00.000Z",
      ];
      yield* fromTestPromise(() =>
        db.batch(
          dates.map((occurredAt, index) =>
            db
              .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES (?, ?, ?, 'COP', 'outflow', ?, ?, '2026-01-01T00:00:00.000Z')`)
              .bind(
                id(index),
                userId,
                index % 2 === 0 ? "9007199254740993.01" : "0.02",
                categoryId,
                occurredAt
              )
          )
        )
      );
      const before = (yield* fromTestPromise(() => aggregateSnapshot(db))).map(
        (result) => result.results
      );
      yield* fromTestPromise(() =>
        applyTestMigration({
          db,
          source: migration,
        })
      );
      expect(
        (yield* fromTestPromise(() => aggregateSnapshot(db))).map((result) => result.results)
      ).toEqual(before);
      for (const [index, _] of dates.entries()) {
        yield* fromTestPromise(() =>
          db
            .prepare("DELETE FROM transactions WHERE user_id = ? AND id = ?")
            .bind(userId, id(index))
            .run()
        );
        const after = (yield* fromTestPromise(() => aggregateSnapshot(db))).map(
          (result) => result.results
        );
        // Rebuild the same remaining leaves using unchanged insert arithmetic as an independent oracle.
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE dashboard_projection_state SET readiness = 'clearing' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        yield* fromTestPromise(() =>
          db.batch([
            db.prepare("DELETE FROM dashboard_projection_bucket WHERE user_id = ?").bind(userId),
            db.prepare("DELETE FROM dashboard_projection_digit WHERE user_id = ?").bind(userId),
            db.prepare("DELETE FROM dashboard_projection_leaf WHERE user_id = ?").bind(userId),
            db
              .prepare(
                "UPDATE dashboard_projection_state SET readiness = 'rebuilding' WHERE user_id = ?"
              )
              .bind(userId),
            db
              .prepare(`INSERT INTO dashboard_projection_leaf SELECT user_id, id, amount, currency, direction,
        category_id, counterparty, notes, occurred_at, created_at, revision FROM dashboard_effective_source WHERE user_id = ?`)
              .bind(userId),
            db
              .prepare(
                "UPDATE dashboard_projection_state SET readiness = 'ready' WHERE user_id = ?"
              )
              .bind(userId),
          ])
        );
        expect(
          (yield* fromTestPromise(() => aggregateSnapshot(db))).map((result) => result.results)
        ).toEqual(after);
      }
    })
  ));
