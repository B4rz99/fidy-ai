import type {
  CompletePeriodAggregates,
  EffectiveTransactionAggregate,
  TransactionPeriod,
} from "../../../src/core/transactions/contract";
import { UserId } from "../../../src/core/identity/contract";
import { prepareConsentAction } from "../../consent/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { TransactionAggregatesUnavailable } from "../contract";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { Currency, Money } from "../../../src/core/_shared/money";
import { CategoryId } from "../../../src/core/categories/contract";

const maximumPeriodDays = 32;
const minutesPerDay = 1440;
const maximumAmountDigits = 5_242_880;
const minuteMs = 60_000;
const dayMs = 86_400_000;
const minorScale = 4;
const GroupRow = Schema.Struct({
  currency: Currency,
  direction: Schema.Literals(["inflow", "outflow"]),
  category_id: CategoryId,
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  max_minor: Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u)),
});
const DigitRow = Schema.Struct({
  currency: Currency,
  direction: Schema.Literals(["inflow", "outflow"]),
  category_id: CategoryId,
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digit_sum: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const StateRow = Schema.Struct({ version: Schema.Literal(1), readiness: Schema.Literal("ready") });

type GroupKey = Readonly<{
  currency: Currency;
  direction: "inflow" | "outflow";
  category_id: CategoryId;
}>;
const groupKey = (row: GroupKey): string => `${row.currency}:${row.direction}:${row.category_id}`;

/** Only a complete, current User projection can supply Dashboard Money. */
export const projectionReady = (raw: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(StateRow)(raw));

export const projectionRange = ({
  from,
  toExclusive,
}: Readonly<{ from: number; toExclusive: number }>): Option.Option<
  Readonly<{
    firstDay: number;
    lastDay: number;
    firstMinute: number;
    lastMinute: number;
  }>
> => {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(toExclusive) ||
    from < 0 ||
    toExclusive <= from ||
    from % minuteMs !== 0 ||
    toExclusive % minuteMs !== 0 ||
    toExclusive - from > maximumPeriodDays * dayMs
  ) {
    return Option.none();
  }
  return Option.some({
    firstDay: Math.ceil(from / dayMs),
    lastDay: Math.floor(toExclusive / dayMs),
    firstMinute: from / minuteMs,
    lastMinute: toExclusive / minuteMs,
  });
};

const selectedBuckets = `FROM transaction_projection_bucket
  WHERE user_id = ? AND (
    (size_seconds = 86400 AND bucket >= ? AND bucket < ?)
    OR (size_seconds = 60 AND bucket >= ? AND bucket < ?
      AND (bucket < ? OR bucket >= ?)))`;
const selectedDigits = selectedBuckets.replaceAll(
  "transaction_projection_bucket",
  "transaction_projection_digit"
);

export const projectionQueries = ({
  db,
  userId,
  range,
}: Readonly<{
  db: D1Database;
  userId: string;
  range: Readonly<{
    firstDay: number;
    lastDay: number;
    firstMinute: number;
    lastMinute: number;
  }>;
}>): Array<D1PreparedStatement> => {
  const params = [
    userId,
    range.firstDay,
    range.lastDay,
    range.firstMinute,
    range.lastMinute,
    range.firstDay * minutesPerDay,
    range.lastDay * minutesPerDay,
  ] as const;
  return [
    db
      .prepare(`WITH chosen AS (SELECT currency, direction, category_id, count, max_minor,
      ROW_NUMBER() OVER (PARTITION BY currency, direction, category_id
        ORDER BY length(max_minor) DESC, max_minor DESC) AS rank ${selectedBuckets})
      SELECT currency, direction, category_id, SUM(count) AS count,
        MAX(CASE WHEN rank = 1 THEN max_minor END) AS max_minor
      FROM chosen GROUP BY currency, direction, category_id ORDER BY currency, direction, category_id`)
      .bind(...params),
    db
      .prepare(`SELECT currency, direction, category_id, position,
      SUM(digit_sum) AS digit_sum ${selectedDigits}
      GROUP BY currency, direction, category_id, position`)
      .bind(...params),
  ];
};

const decodeSums = (rows: ReadonlyArray<unknown>): Option.Option<Map<string, bigint>> => {
  const digits = Option.all(rows.map((row) => Schema.decodeUnknownOption(DigitRow)(row)));
  if (Option.isNone(digits)) return Option.none();
  const sums = new Map<string, bigint>();
  for (const digit of digits.value) {
    if (digit.position > maximumAmountDigits || !Number.isSafeInteger(digit.digit_sum)) {
      return Option.none();
    }
    const key = groupKey(digit);
    sums.set(key, (sums.get(key) ?? 0n) + BigInt(digit.digit_sum) * 10n ** BigInt(digit.position));
  }
  return Option.some(sums);
};

const decodeGroups = (
  rows: ReadonlyArray<unknown>,
  sums: ReadonlyMap<string, bigint>
): Option.Option<ReadonlyArray<EffectiveTransactionAggregate>> => {
  const groups = Option.all(rows.map((row) => Schema.decodeUnknownOption(GroupRow)(row)));
  if (Option.isNone(groups) || groups.value.length !== sums.size) return Option.none();
  const result: Array<EffectiveTransactionAggregate> = [];
  for (const group of groups.value) {
    const sum = sums.get(groupKey(group));
    const maximum = Schema.decodeOption(Schema.toType(Money))({
      amount: BigDecimal.make(BigInt(group.max_minor), minorScale),
      currency: group.currency,
    });
    if (sum === undefined || Option.isNone(maximum) || !Number.isSafeInteger(group.count)) {
      return Option.none();
    }
    const total = Schema.decodeOption(Schema.toType(Money))({
      currency: group.currency,
      amount: BigDecimal.make(sum, minorScale),
    });
    if (Option.isNone(total)) return Option.none();
    result.push({
      categoryId: group.category_id,
      direction: group.direction,
      sum: total.value,
      maximum: maximum.value,
      count: BigInt(group.count),
    });
  }
  return Option.some(result);
};

type AggregateRange = Readonly<{ from: number; toExclusive: number }>;
// At most 32 native batches, leaving room for the caller within the Free invocation query budget.
export const maximumAggregateRanges = 128;
// Bound transient raw results without starting additional concurrent provider work.
export const aggregateRangesPerBatch = 4;

/** Read one exact interval through the bounded projection snapshot reader. */
export const findDashboardAggregate = (
  input: Readonly<{ db: D1Database; userId: string }> & AggregateRange
): Effect.Effect<Option.Option<ReadonlyArray<EffectiveTransactionAggregate>>> =>
  findDashboardAggregateRanges({ ...input, ranges: [input] }).pipe(
    Effect.map(Option.flatMap((ranges) => Option.fromUndefinedOr(ranges[0])))
  );

export type AggregateSnapshot = Readonly<{
  revision: number;
  values: ReadonlyArray<ReadonlyArray<EffectiveTransactionAggregate>>;
}>;

const decodeAggregateRows = (
  rows: ReadonlyArray<D1Result>,
  offset: number
): Option.Option<ReadonlyArray<EffectiveTransactionAggregate>> => {
  const groups = rows[offset];
  const digits = rows[offset + 1];
  return groups === undefined || digits === undefined
    ? Option.none()
    : Option.flatMap(decodeSums(digits.results), (sums) => decodeGroups(groups.results, sums));
};

export const decodeAggregateSnapshot = ({
  rows,
  count,
}: Readonly<{
  rows: ReadonlyArray<D1Result>;
  count: number;
}>): Option.Option<AggregateSnapshot> => {
  const state = rows[0];
  if (rows.length !== 1 + count * 2 || state?.results.length !== 1) return Option.none();
  const revision = Schema.decodeUnknownOption(AggregateRevision)(state.results[0]);
  if (Option.isNone(revision)) return Option.none();
  const values: Array<ReadonlyArray<EffectiveTransactionAggregate>> = [];
  for (let index = 0; index < count; index++) {
    const decoded = decodeAggregateRows(rows, 1 + index * 2);
    if (Option.isNone(decoded)) return Option.none();
    values.push(decoded.value);
  }
  return Option.some({ revision: revision.value.revision, values });
};

/** Read ordered exact intervals in small native snapshots; a changed revision refuses the whole read. */
export const findDashboardAggregateRanges = ({
  db,
  userId,
  ranges,
}: Readonly<{
  db: D1Database;
  userId: string;
  ranges: ReadonlyArray<AggregateRange>;
}>): Effect.Effect<Option.Option<ReadonlyArray<ReadonlyArray<EffectiveTransactionAggregate>>>> =>
  Effect.gen(function* () {
    if (ranges.length > maximumAggregateRanges) return Option.none();
    const prepared = Option.all(ranges.map((range) => projectionRange(range)));
    if (Option.isNone(prepared)) return Option.none();
    const values: Array<ReadonlyArray<EffectiveTransactionAggregate>> = [];
    let observedRevision = Option.none<number>();
    for (let offset = 0; offset < prepared.value.length; offset += aggregateRangesPerBatch) {
      const chunk = prepared.value.slice(offset, offset + aggregateRangesPerBatch);
      const rows = yield* Effect.tryPromise(() =>
        db.batch([
          prepareConsentAction({
            db,
            subject: { _tag: "User", userId: UserId.make(userId) },
            requirement: "unrevoked",
            statement: revisionSelection(UserId.make(userId)),
          }),
          ...chunk.flatMap((range) => projectionQueries({ db, userId, range })),
        ])
      );
      const decoded = decodeAggregateSnapshot({ rows, count: chunk.length });
      if (
        Option.isNone(decoded) ||
        (Option.isSome(observedRevision) && observedRevision.value !== decoded.value.revision)
      ) {
        return Option.none();
      }
      observedRevision = Option.some(decoded.value.revision);
      values.push(...decoded.value.values);
    }
    return Option.some(values);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const AggregateRevision = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const revisionSelection = (
  userId: UserId
): Readonly<{ sql: string; params: readonly [UserId] }> => ({
  sql: `SELECT COALESCE(p.fact_revision, 0) AS revision FROM transaction_projection_state p
    WHERE p.user_id = ? AND p.version = 1 AND p.readiness = 'ready'`,
  params: [userId],
});

const AggregateBatch = Schema.Tuple([
  Schema.Struct({ results: Schema.Array(AggregateRevision).check(Schema.isMaxLength(1)) }),
  Schema.Struct({ results: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ results: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ results: Schema.Array(Schema.Unknown) }),
  Schema.Struct({ results: Schema.Array(Schema.Unknown) }),
]);
const decodeAggregateBatch = (
  raw: unknown,
  periods: readonly [TransactionPeriod, TransactionPeriod]
): Effect.Effect<Option.Option<CompletePeriodAggregates>, TransactionAggregatesUnavailable> => {
  const batch = Schema.decodeUnknownOption(AggregateBatch)(raw);
  if (Option.isNone(batch)) return Effect.fail(new TransactionAggregatesUnavailable());
  const [state, firstGroups, firstDigits, secondGroups, secondDigits] = batch.value;
  const revision = state.results[0];
  if (revision === undefined) return Effect.succeedNone;
  const first = Option.flatMap(decodeSums(firstDigits.results), (sums) =>
    decodeGroups(firstGroups.results, sums)
  );
  const second = Option.flatMap(decodeSums(secondDigits.results), (sums) =>
    decodeGroups(secondGroups.results, sums)
  );
  if (Option.isNone(first) || Option.isNone(second)) {
    return Effect.fail(new TransactionAggregatesUnavailable());
  }
  return Effect.succeedSome({
    revision: revision.revision,
    periods: [
      { period: periods[0], aggregates: first.value },
      { period: periods[1], aggregates: second.value },
    ],
  });
};

/** Both intervals and readiness are read in one D1 snapshot under current processing Consent. */
export const readPeriodAggregates = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    periods: readonly [TransactionPeriod, TransactionPeriod];
  }>
): Effect.Effect<Option.Option<CompletePeriodAggregates>, TransactionAggregatesUnavailable> =>
  Effect.gen(function* () {
    const firstRange = projectionRange({
      from: input.periods[0].from.epochMilliseconds,
      toExclusive: input.periods[0].toExclusive.epochMilliseconds,
    });
    const secondRange = projectionRange({
      from: input.periods[1].from.epochMilliseconds,
      toExclusive: input.periods[1].toExclusive.epochMilliseconds,
    });
    if (Option.isNone(firstRange) || Option.isNone(secondRange)) return Option.none();
    const result = yield* Effect.tryPromise({
      try: () =>
        input.db.batch([
          prepareConsentAction({
            db: input.db,
            subject: { _tag: "User", userId: input.userId },
            requirement: "active",
            statement: revisionSelection(input.userId),
          }),
          ...projectionQueries({ db: input.db, userId: input.userId, range: firstRange.value }),
          ...projectionQueries({ db: input.db, userId: input.userId, range: secondRange.value }),
        ]),
      catch: () => new TransactionAggregatesUnavailable(),
    });
    return yield* decodeAggregateBatch(result, input.periods);
  });

/** A failed readiness, authority or revision assertion aborts all caller-owned publication writes. */
export const periodAggregateGuard = (
  input: Readonly<{ db: D1Database; userId: UserId; revision: number }>
): D1PreparedStatement => {
  const selection = revisionSelection(input.userId);
  const protectedSelection = protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `SELECT 1 FROM (${selection.sql}) WHERE revision = ?`,
      params: [...selection.params, input.revision],
    },
  });
  return input.db
    .prepare(
      `INSERT INTO sql_assertions (scope, accepted) VALUES ('transaction_fact', CASE WHEN EXISTS (${protectedSelection.sql}) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted`
    )
    .bind(...protectedSelection.params);
};
