import type { EffectiveTransactionAggregate } from "../../../src/core/transactions/contract";
import { BigDecimal, Effect, Option, Schema } from "effect";
import { Currency, Money } from "../../../src/core/_shared/money";
import { CategoryId } from "../../../src/core/categories/contract";

const maximumPeriodDays = 32;
const minutesPerDay = 1440;
// A Statement input is capped at 5 MiB; even a single amount consuming it must remain exact.
// This guard bounds corrupt digit positions without introducing a Transaction-history cutoff.
const maximumAmountDigits = 5_242_880;
const minuteMs = 60_000;
const dayMs = 86_400_000;
const minorScale = 4;
const GroupRow = Schema.Struct({
  currency: Currency,
  direction: Schema.Literals(["inflow", "outflow"]),
  category_id: CategoryId,
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  maximum: Schema.String,
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

const projectionRange = (
  from: number,
  toExclusive: number
): Option.Option<
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

const selectedBuckets = `FROM dashboard_projection_bucket
  WHERE user_id = ? AND (
    (size_seconds = 86400 AND bucket >= ? AND bucket < ?)
    OR (size_seconds = 60 AND bucket >= ? AND bucket < ?
      AND (bucket < ? OR bucket >= ?)))`;
const selectedDigits = selectedBuckets.replaceAll(
  "dashboard_projection_bucket",
  "dashboard_projection_digit"
);

const projectionQueries = (
  db: D1Database,
  userId: string,
  range: Readonly<{
    firstDay: number;
    lastDay: number;
    firstMinute: number;
    lastMinute: number;
  }>
): Array<D1PreparedStatement> => {
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
      .prepare(`WITH chosen AS (SELECT currency, direction, category_id, count, maximum,
      ROW_NUMBER() OVER (PARTITION BY currency, direction, category_id
        ORDER BY length(max_minor) DESC, max_minor DESC) AS rank ${selectedBuckets})
      SELECT currency, direction, category_id, SUM(count) AS count,
        MAX(CASE WHEN rank = 1 THEN maximum END) AS maximum
      FROM chosen GROUP BY currency, direction, category_id`)
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
    const maximum = Schema.decodeOption(Money)({
      amount: group.maximum,
      currency: group.currency,
    });
    if (sum === undefined || Option.isNone(maximum) || !Number.isSafeInteger(group.count)) {
      return Option.none();
    }
    result.push({
      categoryId: group.category_id,
      direction: group.direction,
      sum: Money.make({ currency: group.currency, amount: BigDecimal.make(sum, minorScale) }),
      maximum: maximum.value,
      count: BigInt(group.count),
    });
  }
  return Option.some(result);
};

/** Read a bounded UTC-day/minute materialization for a half-open UTC interval. */
export const findDashboardAggregate = ({
  db,
  userId,
  from,
  toExclusive,
}: Readonly<{
  db: D1Database;
  userId: string;
  from: number;
  toExclusive: number;
}>): Effect.Effect<Option.Option<ReadonlyArray<EffectiveTransactionAggregate>>> =>
  Effect.gen(function* () {
    const range = projectionRange(from, toExclusive);
    if (Option.isNone(range)) return Option.none();
    const [groups, digits] = yield* Effect.tryPromise(() =>
      db.batch(projectionQueries(db, userId, range.value))
    );
    if (groups === undefined || digits === undefined) return Option.none();
    const sums = decodeSums(digits.results);
    return Option.flatMap(sums, (decoded) => decodeGroups(groups.results, decoded));
  }).pipe(Effect.orElseSucceed(() => Option.none()));
