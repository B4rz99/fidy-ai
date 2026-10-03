import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { RecurringTransactionFact, TransactionId } from "../../../src/core/transactions/contract";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import { type UserId } from "../../../src/core/identity/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { prepareConsentAction } from "../../consent/operations";
import {
  type BudgetContributionCursor,
  type RecurringFactPage,
  type RecurringFactSnapshot,
  RecurringFactsUnavailable,
} from "../contract";
import { effectiveTransactionRelation } from "./effective-transaction";

const pageSize = 128;
const backfillDays = 30;
const millisecondsPerDay = 86_400_000;
const Snapshot = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  firstCapturedAt: UtcTimestamp,
  timeZone: IanaTimeZone,
});
const Row = Schema.Struct({
  id: TransactionId,
  amount: Schema.String,
  currency: Schema.String,
  counterparty: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  created_at: Schema.String,
});
const snapshotRead = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: UserId }>): D1PreparedStatement =>
  prepareConsentAction({
    db,
    subject: { _tag: "User", userId },
    requirement: "active",
    statement: {
      sql: "SELECT revision, first_captured_at AS firstCapturedAt, time_zone AS timeZone FROM transaction_fact_state WHERE user_id = ?",
      params: [userId],
    },
  });
export const findSnapshot = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<RecurringFactSnapshot>, RecurringFactsUnavailable> =>
  Effect.tryPromise({
    try: () => snapshotRead(input).first(),
    catch: () => new RecurringFactsUnavailable(),
  }).pipe(
    Effect.flatMap(
      (raw): Effect.Effect<Option.Option<RecurringFactSnapshot>, RecurringFactsUnavailable> => {
        if (raw === null) return Effect.succeedNone;
        const value = Schema.decodeUnknownOption(Snapshot)(raw);
        return Option.isSome(value)
          ? Effect.succeed(value)
          : Effect.fail(new RecurringFactsUnavailable());
      }
    )
  );
const decodeFact = (raw: unknown): Option.Option<RecurringTransactionFact> =>
  Option.flatMap(Schema.decodeUnknownOption(Row)(raw), (row) => {
    const created = Schema.decodeOption(UtcTimestamp)(row.created_at);
    const occurred = Schema.decodeOption(UtcTimestamp)(row.occurred_at);
    if (Option.isNone(created) || Option.isNone(occurred)) return Option.none();
    return Schema.decodeOption(Schema.toCodecJson(RecurringTransactionFact))({
      id: row.id,
      money: { amount: row.amount, currency: row.currency },
      ...(row.counterparty === null ? {} : { counterparty: row.counterparty }),
      occurredAt: row.occurred_at,
      backfill:
        created.value.epochMilliseconds - occurred.value.epochMilliseconds >
        backfillDays * millisecondsPerDay,
    });
  });
const decodePage = ({
  rows,
  cursor,
}: Readonly<{ rows: ReadonlyArray<unknown>; cursor: BudgetContributionCursor }>): Effect.Effect<
  RecurringFactPage,
  RecurringFactsUnavailable
> => {
  if (rows.length > pageSize) return Effect.fail(new RecurringFactsUnavailable());
  const facts = Option.all(rows.map(decodeFact));
  if (Option.isNone(facts)) return Effect.fail(new RecurringFactsUnavailable());
  const last = facts.value.at(-1);
  return Effect.succeed({
    facts: facts.value,
    cursor:
      last === undefined
        ? cursor
        : { occurredAt: DateTime.formatIso(last.occurredAt), transactionId: last.id },
    complete: rows.length < pageSize,
  });
};
export const readFacts = ({
  db,
  userId,
  revision,
  cursor,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  revision: number;
  cursor: BudgetContributionCursor;
}>): Effect.Effect<Option.Option<RecurringFactPage>, RecurringFactsUnavailable> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const result = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          snapshotRead({ db, userId }),
          ((): D1PreparedStatement => {
            const protectedRead = protectConsentStatement({
              subject: { _tag: "User", userId },
              requirement: "active",
              statement: {
                sql: `WITH ${relation.sql} SELECT id, amount, currency, counterparty, occurred_at, created_at FROM effective_transaction WHERE user_id = ? AND direction = 'outflow' AND (occurred_at, id) > (?, ?) AND EXISTS (SELECT 1 FROM transaction_fact_state WHERE user_id = ? AND revision = ?)`,
                params: [
                  ...relation.bindings,
                  userId,
                  cursor.occurredAt,
                  cursor.transactionId,
                  userId,
                  revision,
                ],
              },
            });
            return db
              .prepare(`${protectedRead.sql} ORDER BY occurred_at, id LIMIT ${pageSize}`)
              .bind(...protectedRead.params);
          })(),
        ]),
      catch: () => new RecurringFactsUnavailable(),
    });
    const snapshot = result[0]?.results[0];
    const state = Schema.decodeUnknownOption(Snapshot)(snapshot);
    if (Option.isNone(state) || state.value.revision !== revision) return Option.none();
    const rows = result[1]?.results;
    if (rows === undefined) return yield* new RecurringFactsUnavailable();
    return Option.some(yield* decodePage({ rows, cursor }));
  });
export const revisionGuard = ({
  db,
  userId,
  revision,
}: Readonly<{ db: D1Database; userId: UserId; revision: number }>): D1PreparedStatement => {
  const allowed = protectConsentStatement({
    subject: { _tag: "User", userId },
    requirement: "active",
    statement: {
      sql: "SELECT 1 FROM transaction_fact_state WHERE user_id = ? AND revision = ?",
      params: [userId, revision],
    },
  });
  return db
    .prepare(
      `INSERT INTO transaction_fact_assertion (id, accepted) VALUES (1, CASE WHEN EXISTS (${allowed.sql}) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`
    )
    .bind(...allowed.params);
};
export const revisionProjection = ({
  db,
  statement,
}: Readonly<{
  db: D1Database;
  statement: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(
      `WITH transaction_fact_revisions AS (SELECT user_id AS userId, revision FROM transaction_fact_state) ${statement.sql}`
    )
    .bind(...statement.params);
