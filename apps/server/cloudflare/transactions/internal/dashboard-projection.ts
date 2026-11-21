import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { EffectiveTransactionAggregate } from "../../../src/core/transactions/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { TransactionAggregatesUnavailable } from "../contract";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { Currency, Money, currencyMetadata } from "../../../src/core/_shared/money";
import { currentCategoryRelease, interpretCategory } from "../../../src/core/categories/operations";
import { CategoryId, CategoryReference } from "../../../src/core/categories/contract";

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

type ProjectionRange = Readonly<{
  firstDay: number;
  lastDay: number;
  firstMinute: number;
  lastMinute: number;
}>;

type ProjectionSpan = Readonly<{ size: number; from: number; toExclusive: number }>;

const projectionSpans = (range: ProjectionRange): ReadonlyArray<ProjectionSpan> => [
  { size: 86400, from: range.firstDay, toExclusive: range.lastDay },
  {
    size: 60,
    from: range.firstMinute,
    toExclusive: Math.min(range.lastMinute, range.firstDay * minutesPerDay),
  },
  {
    size: 60,
    from: Math.max(
      range.firstMinute,
      range.firstDay * minutesPerDay,
      range.lastDay * minutesPerDay
    ),
    toExclusive: range.lastMinute,
  },
];

const selectedSpans = (
  table: "transaction_projection_bucket" | "transaction_projection_digit",
  columns: string,
  spans: ReadonlyArray<ProjectionSpan>
): string =>
  spans
    .map(
      ({ size }) =>
        `SELECT ${columns} FROM ${table} WHERE user_id = (SELECT userId FROM owner) AND size_seconds = ${size} AND bucket >= ? AND bucket < ?`
    )
    .join(" UNION ALL ");

const aggregateStatements = (
  selection: OwnedStatement,
  range: ProjectionRange
): ReadonlyArray<OwnedStatement> => {
  const spans = projectionSpans(range);
  const buckets = `FROM (${selectedSpans("transaction_projection_bucket", "currency,direction,category_id,count,max_minor", spans)})`;
  const digits = `FROM (${selectedSpans("transaction_projection_digit", "currency,direction,category_id,position,digit_sum", spans)})`;

  const params = [
    ...selection.params,
    ...spans.flatMap(({ from, toExclusive }) => [from, toExclusive]),
  ];

  return [
    {
      sql: `WITH owner AS MATERIALIZED (${selection.sql}), chosen AS (SELECT currency, direction, category_id, count, max_minor,
      ROW_NUMBER() OVER (PARTITION BY currency, direction, category_id
        ORDER BY length(max_minor) DESC, max_minor DESC) AS rank ${buckets})
      SELECT currency, direction, category_id, SUM(count) AS count,
        MAX(CASE WHEN rank = 1 THEN max_minor END) AS max_minor
      FROM chosen GROUP BY currency, direction, category_id ORDER BY currency, direction, category_id`,
      params,
    },
    {
      sql: `WITH owner AS MATERIALIZED (${selection.sql}) SELECT currency, direction, category_id, position,
      SUM(digit_sum) AS digit_sum ${digits}
      GROUP BY currency, direction, category_id, position`,
      params,
    },
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

const plausibleTotal = (sum: bigint, group: typeof GroupRow.Type, count: bigint): boolean => {
  const maximum = BigInt(group.max_minor);
  const smallest = 10n ** BigInt(minorScale - currencyMetadata(group.currency).fractionalDigits);

  return maximum >= smallest && sum >= maximum + (count - 1n) * smallest && sum <= maximum * count;
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

    const count = BigInt(group.count);

    const total = Schema.decodeOption(Schema.toType(Money))({
      currency: group.currency,
      amount: BigDecimal.make(sum, minorScale),
    }).pipe(Option.filter(() => plausibleTotal(sum, group, count)));

    if (Option.isNone(total)) return Option.none();
    result.push({
      categoryId: group.category_id,
      direction: group.direction,
      sum: total.value,
      maximum: maximum.value,
      count,
    });
  }

  return Option.some(result);
};

export const localProjectionRange = Effect.fn(function* (
  userId: UserId,
  from: number,
  toExclusive: number
) {
  const sql = yield* SqliteClient;

  const range = yield* Effect.fromOption(
    projectionRange({ from, toExclusive }),
    () => new TransactionAggregatesUnavailable()
  );

  const [groups, digits] = yield* Effect.forEach(
    aggregateStatements({ sql: "SELECT ? AS userId", params: [userId] }, range),
    (statement) => sql.unsafe(statement.sql, statement.params)
  );

  if (groups === undefined || digits === undefined) {
    return yield* new TransactionAggregatesUnavailable();
  }

  return yield* Effect.fromOption(
    Option.flatMap(decodeSums(digits), (sums) => decodeGroups(groups, sums)),
    () => new TransactionAggregatesUnavailable()
  );
});

export const localProjectionReady = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const [state] =
    yield* sql`SELECT version, readiness FROM transaction_projection_state WHERE user_id=${user}`;

  if (!projectionReady(state)) return false;

  const limit = currentCategoryRelease.revisions.reduce(
    (total, revision) => total + revision.categories.length,
    0
  );

  const refs = yield* Schema.decodeUnknownEffect(Schema.Array(CategoryReference))(
    yield* sql`SELECT category_revision AS revision,category_id AS categoryId FROM transaction_projection_references WHERE user_id=${user} LIMIT ${limit + 1}`
  );

  if (
    refs.length > limit ||
    refs.some((reference) =>
      Option.isNone(interpretCategory({ release: currentCategoryRelease, reference }))
    )
  ) {
    return yield* new TransactionAggregatesUnavailable();
  }

  return true;
});
