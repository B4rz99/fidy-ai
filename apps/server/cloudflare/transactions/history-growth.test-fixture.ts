import { Data, Effect, Schema } from "effect";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <Value>(run: () => PromiseLike<Value>): Effect.Effect<Value> =>
  Effect.tryPromise({ try: run, catch: () => new TestPromiseFailure() }).pipe(Effect.orDie);
const categoryId = "10000000-0000-4000-8000-000000000016";

export const seedHistory = ({
  db,
  subject,
  transactionPrefix,
  count,
  linked,
  linkedFraction,
  spacingMinutes,
}: Readonly<{
  db: D1Database;
  subject: string;
  transactionPrefix: string;
  count: number;
  linked: boolean;
  linkedFraction: number;
  spacingMinutes: number;
}>): Effect.Effect<void> =>
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
    ('transaction_projection_capture', 'transaction_projection_link_member')`)
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
      category_id, occurred_at_ms, created_at_ms)
    SELECT ? || printf('%012d', i), ?, '100', 'COP', 'outflow', 'shop', ?,CAST(round(unixepoch(strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || (i * ?) || ' minutes'),'subsec')*1000) AS INTEGER),CAST(round(unixepoch(strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || (i * ?) || ' minutes', '+1 second'),'subsec')*1000) AS INTEGER) FROM n`)
        .bind(count, transactionPrefix, subject, categoryId, spacingMinutes, spacingMinutes)
        .run()
    );
    yield* seedReconciliation({ db, subject, transactionPrefix, count, linked, linkedFraction });
    yield* fromTestPromise(() => db.batch(triggers.map((trigger) => db.prepare(trigger.sql))));
    yield* prepareProjection(db, subject);
  });

const prepareProjection = (db: D1Database, subject: string): Effect.Effect<unknown> =>
  fromTestPromise(() =>
    db.batch([
      db
        .prepare(
          "UPDATE transaction_projection_state SET readiness = 'rebuilding' WHERE user_id = ?"
        )
        .bind(subject),
      db
        .prepare(`INSERT INTO transaction_projection_leaf
      (user_id, id, amount, currency, direction, counterparty, category_id, notes,
        occurred_at_ms, created_at_ms, revision)
      SELECT user_id, id, amount, currency, direction, counterparty, category_id, notes,
        occurred_at_ms, created_at_ms, revision FROM transaction_effective_source WHERE user_id = ?`)
        .bind(subject),
      db
        .prepare("UPDATE transaction_projection_state SET readiness = 'ready' WHERE user_id = ?")
        .bind(subject),
    ])
  );

const seedReconciliation = ({
  db,
  subject,
  transactionPrefix,
  count,
  linked,
  linkedFraction,
}: Readonly<{
  db: D1Database;
  subject: string;
  transactionPrefix: string;
  count: number;
  linked: boolean;
  linkedFraction: number;
}>): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (linked) {
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO transaction_reconciliation_decisions
      SELECT ?, ? || printf('%012d', 2 * i - 1), ? || printf('%012d', 2 * i),
        'linked', ? || printf('%012d', 2 * i - 1), 1767225600000  FROM n`)
          .bind(
            Math.floor((count * linkedFraction) / 2),
            subject,
            transactionPrefix,
            transactionPrefix,
            transactionPrefix
          )
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`UPDATE transactions SET reconciliation_first_id=incoming.first_transaction_id,reconciliation_second_id=incoming.second_transaction_id FROM (
      SELECT user_id, first_transaction_id AS transaction_id, first_transaction_id, second_transaction_id
        FROM transaction_reconciliation_decisions WHERE user_id = ?
      UNION ALL SELECT user_id, second_transaction_id, first_transaction_id, second_transaction_id
        FROM transaction_reconciliation_decisions WHERE user_id = ?
      ) incoming WHERE transactions.user_id=incoming.user_id AND transactions.id=incoming.transaction_id`)
          .bind(subject, subject)
          .run()
      );
    }
  });
