import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { RecurringTransactionFact, TransactionId } from "../../../src/core/transactions/contract";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import { type UserId } from "../../../src/core/identity/contract";
import {
  type BudgetContributionCursor,
  type RecurringFactPage,
  RecurringFactsUnavailable,
} from "../contract";

const pageSize = 128;

const backfillDays = 30;

const millisecondsPerDay = 86_400_000;

const Snapshot = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  firstCapturedAt: Schema.DateTimeUtcFromMillis,
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

const decodeFact = (raw: unknown): Option.Option<RecurringTransactionFact> =>
  Option.flatMap(Schema.decodeUnknownOption(Row)(raw), (row) => {
    const created = Schema.decodeOption(UtcTimestamp)(row.created_at);
    const occurred = Schema.decodeOption(UtcTimestamp)(row.occurred_at);

    if (Option.isNone(created) || Option.isNone(occurred)) return Option.none();

    return Schema.decodeOption(Schema.toCodecJson(RecurringTransactionFact))({
      id: row.id,
      money: { amount: row.amount, currency: row.currency },
      ...Option.match(Option.fromNullOr(row.counterparty), {
        onNone: () => ({}),
        onSome: (counterparty) => ({ counterparty }),
      }),
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

export const localFactSnapshot = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT fact_revision AS revision,first_captured_at_ms AS firstCapturedAt,time_zone AS timeZone FROM transaction_projection_state WHERE user_id=${user} AND fact_revision IS NOT NULL`;

  return row === undefined
    ? Option.none()
    : Option.some(yield* Schema.decodeUnknownEffect(Snapshot)(row));
});

const beforeEarliestTimestamp = -62_135_596_800_001;

export const localFactPage = Effect.fn(function* (user: UserId, cursor: BudgetContributionCursor) {
  const sql = yield* SqliteClient;

  const after =
    cursor.occurredAt === ""
      ? beforeEarliestTimestamp
      : (yield* Schema.decodeEffect(UtcTimestamp)(cursor.occurredAt)).epochMilliseconds;

  const [state] =
    yield* sql`SELECT readiness,version FROM transaction_projection_state WHERE user_id=${user}`;

  const ready = Schema.is(
    Schema.Struct({ readiness: Schema.Literal("ready"), version: Schema.Literal(1) })
  )(state);

  const source = ready ? "transaction_projection_leaf" : "transaction_effective_source";

  const rows = yield* sql.unsafe(
    `SELECT id,amount,currency,counterparty,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at FROM ${source} WHERE user_id=? AND direction='outflow' AND (occurred_at_ms,id)>(?,?) ORDER BY occurred_at_ms,id LIMIT ${pageSize}`,
    [user, after, cursor.transactionId]
  );

  return yield* decodePage({ rows, cursor });
});
