import { encodeMoneyAmount } from "../../src/core/_shared/money";
import { Data, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import { seedHistory } from "./history-growth.test-fixture";
import { findDashboardAggregate, repairDashboardProjection } from "./operations";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: run,
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000051";
const prefix = "20000000-0000-4000-8000-";
const setup = (count: number): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => databases.acquire());
    yield* fromTestPromise(() =>
      installTestSchema({
        db,
      })
    );
    yield* fromTestPromise(() =>
      db
        .prepare(`INSERT INTO users(id, service_market, locale, time_zone, created_at_ms)
    VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)`)
        .bind(userId)
        .run()
    );
    if (count > 0) {
      yield* seedHistory({
        db,
        subject: userId,
        transactionPrefix: prefix,
        count,
        linked: false,
        linkedFraction: 0,
        spacingMinutes: 20,
      });
    }
    yield* fromTestPromise(() =>
      db
        .prepare(`INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms)
    VALUES('processing_grant','repair-grant',?,'{}','disclosed','accepted',0,0)`)
        .bind(userId)
        .run()
    );
    expect(Option.isSome(yield* aggregate(db))).toBe(true);
    return db;
  });
const aggregate = (db: D1Database): ReturnType<typeof findDashboardAggregate> =>
  findDashboardAggregate({
    db,
    userId,
    from: 1577836800000,
    toExclusive: 1580515200000,
  });
const repair = (db: D1Database): Effect.Effect<"ready" | "pending"> =>
  repairDashboardProjection({
    db,
    userId,
  }).pipe(Effect.orDie);
const finish = (db: D1Database, remaining = 100): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (remaining === 0) throw new Error("Repair did not complete within bounded pages");
    if ((yield* repair(db)) === "ready") return;
    expect(Option.isNone(yield* aggregate(db))).toBe(true);
    return yield* finish(db, remaining - 1);
  });
const untilPhase = (db: D1Database, phase: string, remaining = 100): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (remaining === 0) throw new Error("Repair did not reach requested phase");
    if (
      (yield* fromTestPromise(() =>
        db
          .prepare("SELECT readiness FROM transaction_projection_state WHERE user_id = ?")
          .bind(userId)
          .first("readiness")
      )) === phase
    ) {
      return;
    }
    yield* repair(db);
    return yield* untilPhase(db, phase, remaining - 1);
  });
const obsoleteVersion = (db: D1Database): Effect.Effect<unknown> =>
  fromTestPromise(() =>
    db
      .prepare("UPDATE transaction_projection_state SET version = 0 WHERE user_id = ?")
      .bind(userId)
      .run()
  );
const pendingSteps = (db: D1Database, remaining: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (remaining === 0) return;
    expect(yield* repair(db)).toBe("pending");
    expect(Option.isNone(yield* aggregate(db))).toBe(true);
    return yield* pendingSteps(db, remaining - 1);
  });
it(
  "repairs an obsolete version without restarting or changing authoritative facts",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(257);
        const expected = yield* aggregate(db);
        const metadata = yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT fact_revision, first_captured_at_ms, time_zone FROM transaction_projection_state WHERE user_id = ?"
            )
            .bind(userId)
            .first()
        );
        const foreignId = "10000000-0000-4000-8000-000000000052";
        yield* fromTestPromise(() =>
          db
            .prepare(`INSERT INTO users(id, service_market, locale, time_zone, created_at_ms)
    VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)`)
            .bind(foreignId)
            .run()
        );
        yield* seedHistory({
          db,
          subject: foreignId,
          transactionPrefix: "30000000-0000-4000-8000-",
          count: 2,
          linked: false,
          linkedFraction: 0,
          spacingMinutes: 20,
        });
        const foreignQuery = (): ReturnType<typeof aggregate> =>
          findDashboardAggregate({
            db,
            userId: foreignId,
            from: 1577836800000,
            toExclusive: 1580515200000,
          });
        yield* fromTestPromise(() =>
          db
            .prepare(`INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms)
    VALUES('processing_grant','foreign-grant',?,'{}','disclosed','accepted',0,0)`)
            .bind(foreignId)
            .run()
        );
        const foreignBefore = yield* foreignQuery();
        expect(Option.isSome(foreignBefore)).toBe(true);
        const facts = yield* fromTestPromise(() =>
          db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY id").bind(userId).all()
        );
        yield* fromTestPromise(() =>
          db
            .prepare("UPDATE transaction_projection_state SET version = 0 WHERE user_id = ?")
            .bind(userId)
            .run()
        );
        expect(Option.isNone(yield* aggregate(db))).toBe(true);
        yield* finish(db);
        expect(yield* aggregate(db)).toEqual(expected);
        expect(yield* foreignQuery()).toEqual(foreignBefore);
        expect(
          yield* fromTestPromise(() =>
            db
              .prepare(
                "SELECT fact_revision, first_captured_at_ms, time_zone FROM transaction_projection_state WHERE user_id = ?"
              )
              .bind(userId)
              .first()
          )
        ).toEqual(metadata);
        expect(
          (yield* fromTestPromise(() =>
            db
              .prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY id")
              .bind(userId)
              .all()
          )).results
        ).toEqual(facts.results);
      })
    ),
  60_000
);

const delayedPage = (db: D1Database, beforePage: Effect.Effect<void>): D1Database => {
  let batches = 0;
  return {
    prepare: db.prepare.bind(db),
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
    batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
      Effect.runPromise(
        Effect.gen(function* () {
          batches++;
          if (batches === 2) yield* beforePage;
          return yield* fromTestPromise(() => db.batch<Row>(statements));
        })
      ),
  };
};
it.each(["clearing-buckets", "clearing-digits", "clearing", "rebuilding"])(
  "refuses a delayed %s page after another worker completes repair",
  (phase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(257);
        const expected = yield* aggregate(db);
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE transaction_projection_state SET readiness = 'dirty' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        if (phase !== "clearing-buckets") {
          yield* untilPhase(db, phase);
        }
        const observed = observeRetentionCost(db);
        let beforeWrites = 0;
        const delayed = delayedPage(
          observed.database,
          Effect.gen(function* () {
            yield* finish(db);
            beforeWrites = observed.cost().rowsWritten;
          })
        );
        expect(yield* repair(delayed)).toBe("ready");
        expect(observed.cost().rowsWritten - beforeWrites).toBe(0);
        expect(yield* aggregate(db)).toEqual(expected);
      })
    ),
  60_000
);
it.each(["clearing-buckets", "clearing-digits", "clearing", "rebuilding"])(
  "does not consume another page when a concurrent %s worker advances",
  (phase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(513);
        const expected = yield* aggregate(db);
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE transaction_projection_state SET readiness = 'dirty' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        if (phase !== "clearing-buckets") {
          yield* untilPhase(db, phase);
        }
        const observed = observeRetentionCost(db);
        let beforeWrites = 0;
        yield* repair(
          delayedPage(
            observed.database,
            Effect.gen(function* () {
              yield* repair(db);
              beforeWrites = observed.cost().rowsWritten;
            })
          )
        );
        expect(observed.cost().rowsWritten - beforeWrites).toBe(0);
        yield* finish(db);
        expect(yield* aggregate(db)).toEqual(expected);
      })
    ),
  60_000
);
it.each([0, 256, 257])(
  "finishes interrupted repair of %i Transactions with exact final aggregates",
  (count) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(count);
        const expected = yield* aggregate(db);
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE transaction_projection_state SET readiness = 'dirty' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        yield* finish(db);
        expect(yield* aggregate(db)).toEqual(expected);
      })
    ),
  60_000
);
it(
  "preserves new facts ahead and behind the cursor without restarting on fact revisions",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(257);
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE transaction_projection_state SET readiness = 'dirty' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        yield* untilPhase(db, "rebuilding");
        expect(yield* repair(db)).toBe("pending");
        yield* fromTestPromise(() =>
          db.batch(
            [
              ["10000000-0000-4000-8000-000000000099", "2"],
              ["90000000-0000-4000-8000-000000000099", "3"],
            ].map(([id, amount]) =>
              db
                .prepare(`INSERT INTO transactions
      (id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms)
      VALUES (?, ?, ?, 'COP', 'outflow', '10000000-0000-4000-8000-000000000016', 1577854800000, 1577854800000)`)
                .bind(id, userId, amount)
            )
          )
        );
        expect(Option.isNone(yield* aggregate(db))).toBe(true);
        expect(yield* repair(db)).toBe("ready");
        const groups = Option.getOrThrow(yield* aggregate(db));
        expect(
          groups.map((group) => [String(group.count), encodeMoneyAmount(group.sum.amount)])
        ).toEqual([["259", "25705"]]);
      })
    ),
  60_000
);
it(
  "rejects a delayed clearing page when a new generation reaches the same phase and cursor",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(513);
        const expected = yield* aggregate(db);
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE transaction_projection_state SET readiness = 'dirty' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        const observed = observeRetentionCost(db);
        let beforeWrites = 0;
        yield* repair(
          delayedPage(
            observed.database,
            Effect.gen(function* () {
              yield* obsoleteVersion(db);
              yield* repair(db);
              beforeWrites = observed.cost().rowsWritten;
            })
          )
        );
        expect(observed.cost().rowsWritten - beforeWrites).toBe(0);
        yield* finish(db);
        expect(yield* aggregate(db)).toEqual(expected);
      })
    ),
  60_000
);
it(
  "keeps an inconsistent leaf unavailable and repairs it on the next attempt",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(2);
        const expected = yield* aggregate(db);
        yield* fromTestPromise(() =>
          db
            .prepare(
              "UPDATE transaction_projection_state SET readiness = 'rebuilding' WHERE user_id = ?"
            )
            .bind(userId)
            .run()
        );
        yield* fromTestPromise(() =>
          db
            .prepare("UPDATE transaction_projection_leaf SET amount = '999' WHERE user_id = ?")
            .bind(userId)
            .run()
        );
        expect(yield* repair(db)).toBe("pending");
        expect(Option.isNone(yield* aggregate(db))).toBe(true);
        yield* finish(db);
        expect(yield* aggregate(db)).toEqual(expected);
      })
    ),
  60_000
);
it(
  "withholds cutover for inconsistent Reconciliation membership",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(2);
        yield* fromTestPromise(() =>
          db
            .prepare(`INSERT INTO transaction_reconciliation_decisions
    (user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at_ms)
    VALUES (?, ?, ?, 'linked', ?, 1767225600000)`)
            .bind(userId, `${prefix}000000000001`, `${prefix}000000000002`, `${prefix}000000000001`)
            .run()
        );
        yield* pendingSteps(db, 30);
        yield* fromTestPromise(() =>
          db
            .prepare(
              `UPDATE transactions SET reconciliation_first_id = ?, reconciliation_second_id = ? WHERE user_id = ?`
            )
            .bind(`${prefix}000000000001`, `${prefix}000000000002`, userId)
            .run()
        );
        yield* finish(db);
        expect(
          Option.getOrThrow(yield* aggregate(db)).map((group) => [
            String(group.count),
            encodeMoneyAmount(group.sum.amount),
          ])
        ).toEqual([["1", "100"]]);
      })
    ),
  60_000
);
