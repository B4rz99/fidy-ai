import { BigDecimal, Effect, Option, Schema } from "effect";
import { Money, currencyMetadata } from "../../../src/core/_shared/money";
import { type Category, CategoryId } from "../../../src/core/categories/contract";
import {
  Direction,
  type EffectiveTransactionAggregate,
} from "../../../src/core/transactions/contract";
import {
  type DashboardTransactionList,
  type SqliteDashboardTransactions,
  TransactionAggregatesUnavailable,
} from "../contract";
import { foldSpanish } from "./selected-dashboard-lists";
import { decodeDashboardTransactions } from "./dashboard-query";

type Range = Readonly<{ from: number; toExclusive: number }>;
type Exact = number | bigint;
type Group = {
  categoryId: CategoryId;
  currency: Money["currency"];
  direction: Direction;
  sum: Exact;
  maximum: Exact;
  count: bigint;
};
const Row = Schema.Struct({
  amount: Schema.String,
  currency: Money.fields.currency,
  category_id: CategoryId,
  direction: Direction,
  occurred_at_ms: Schema.Int,
});
const decodeRow = Schema.decodeUnknownSync(Row);
const encodeCategories = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CategoryId)));
const decodeMoney = Schema.decodeUnknownSync(Money);
const compactAmount = /^(?:0|[1-9]\d{0,10})(?:\.(\d{1,4}))?$/u;
const minorAmount = (row: typeof Row.Type, mode: "compact" | "bigint"): Exact => {
  const matched = mode === "compact" ? compactAmount.exec(row.amount) : null;
  const fraction = matched?.[1] ?? "";
  if (matched !== null && fraction.length <= currencyMetadata(row.currency).fractionalDigits) {
    return Number(row.amount.split(".")[0]) * minorFactor + Number(fraction.padEnd(4, "0"));
  }
  const amount = BigDecimal.normalize(
    decodeMoney({ amount: row.amount, currency: row.currency }).amount
  );
  const coefficient = amount.value * 10n ** BigInt(scale - amount.scale);
  return mode === "compact" && coefficient <= safe ? Number(coefficient) : coefficient;
};
const scale = 4;
const minorFactor = 10000;
const safe = BigInt(Number.MAX_SAFE_INTEGER);
const add = (left: Exact, right: Exact): Exact =>
  typeof left === "number" && typeof right === "number" && left <= Number.MAX_SAFE_INTEGER - right
    ? left + right
    : BigInt(left) + BigInt(right);
const maximum = (left: Exact, right: Exact): Exact => (left > right ? left : right);
const key = (row: Pick<Group, "categoryId" | "currency" | "direction">): string =>
  `${row.categoryId}:${row.currency}:${row.direction}`;
const mergeRanges = (ranges: ReadonlyArray<Range>): ReadonlyArray<Range> => {
  const merged: Array<Range> = [];
  for (const range of [...ranges].sort((left, right) => left.from - right.from)) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.toExclusive < range.from) merged.push(range);
    else {
      merged[merged.length - 1] = {
        from: previous.from,
        toExclusive: Math.max(previous.toExclusive, range.toExclusive),
      };
    }
  }
  return merged;
};
const segmentAt = (boundaries: ReadonlyArray<number>, instant: number): number => {
  let from = 0;
  let to = boundaries.length - 1;
  while (from < to) {
    const middle = Math.ceil((from + to) / 2);
    if ((boundaries[middle] ?? Infinity) <= instant) from = middle;
    else to = middle - 1;
  }
  return from;
};
const retain = (groups: Map<string, Group>, incoming: Group): boolean => {
  const previous = groups.get(key(incoming));
  if (previous === undefined) {
    groups.set(key(incoming), incoming);
    return typeof incoming.sum === "bigint";
  }
  const wasCompact = typeof previous.sum === "number";
  previous.sum = add(previous.sum, incoming.sum);
  previous.maximum = maximum(previous.maximum, incoming.maximum);
  previous.count += incoming.count;
  return wasCompact && typeof previous.sum === "bigint";
};
const project = (
  groups: ReadonlyMap<string, Group>
): ReadonlyArray<EffectiveTransactionAggregate> =>
  [...groups.values()].map((group) => ({
    categoryId: group.categoryId,
    direction: group.direction,
    count: group.count,
    sum: { currency: group.currency, amount: BigDecimal.make(BigInt(group.sum), scale) },
    maximum: { currency: group.currency, amount: BigDecimal.make(BigInt(group.maximum), scale) },
  }));
const rangeFacts = (
  ranges: ReadonlyArray<Range>,
  boundaries: ReadonlyArray<number>,
  segments: ReadonlyMap<number, ReadonlyMap<string, Group>>
): SqliteDashboardTransactions["ranges"] =>
  ranges.map((range) => {
    const groups = new Map<string, Group>();
    for (const [index, facts] of segments) {
      const boundary = boundaries[index];
      if (boundary === undefined || boundary < range.from || boundary >= range.toExclusive) {
        continue;
      }
      for (const fact of facts.values()) retain(groups, { ...fact });
    }
    return project(groups);
  });
const boundariesFor = (ranges: ReadonlyArray<Range>): ReadonlyArray<number> =>
  [...new Set(ranges.flatMap((range) => [range.from, range.toExclusive]))].sort(
    (left, right) => left - right
  );
const fold = ({
  sql,
  userId,
  ranges,
  mode,
}: Readonly<{
  sql: SqlStorage;
  userId: string;
  ranges: ReadonlyArray<Range>;
  mode: "compact" | "bigint";
}>): Omit<SqliteDashboardTransactions, "lists"> => {
  const spans = mergeRanges(ranges);
  const boundaries = boundariesFor(ranges);
  const segments = new Map<number, Map<string, Group>>();
  let financialRows = 0;
  let rowsRead = 0;
  let promotions = 0;
  for (const span of spans) {
    const cursor = sql.exec(
      `SELECT amount,currency,category_id,direction,occurred_at_ms FROM transaction_effective_source
      WHERE user_id=? AND occurred_at_ms>=? AND occurred_at_ms<?`,
      userId,
      span.from,
      span.toExclusive
    );
    for (const raw of cursor) {
      const row = decodeRow(raw);
      const value = minorAmount(row, mode);
      if (value === 0 || value === 0n) throw new TransactionAggregatesUnavailable();
      const index = segmentAt(boundaries, row.occurred_at_ms);
      const groups = segments.get(index) ?? new Map<string, Group>();
      segments.set(index, groups);
      if (
        retain(groups, {
          categoryId: row.category_id,
          currency: row.currency,
          direction: row.direction,
          sum: value,
          maximum: value,
          count: 1n,
        })
      ) {
        promotions++;
      }
      financialRows++;
    }
    rowsRead += cursor.rowsRead;
  }
  return {
    ranges: rangeFacts(ranges, boundaries, segments),
    measurement: {
      scans: spans.length,
      financialRows,
      rowsRead,
      workingGroups: [...segments.values()].reduce((count, groups) => count + groups.size, 0),
      promotions,
    },
  };
};
const listFacts = ({
  sql,
  userId,
  lists,
  categories,
}: Readonly<{
  sql: SqlStorage;
  userId: string;
  lists: ReadonlyArray<DashboardTransactionList>;
  categories: ReadonlyArray<Category>;
}>): SqliteDashboardTransactions["lists"] =>
  lists.map((list) => {
    const rows = sql
      .exec(
        `SELECT id,amount,currency,direction,counterparty,notes,category_id,revision,
    strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at
    FROM transaction_effective_source WHERE user_id=?
      AND (?='[]' OR category_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR instr(lower(${foldSpanish("coalesce(counterparty,'') || ' ' || coalesce(notes,'')")}),?)>0)
    ORDER BY occurred_at_ms DESC,created_at_ms DESC,id DESC LIMIT ?`,
        userId,
        encodeCategories(list.categories),
        encodeCategories(list.categories),
        Option.getOrNull(list.search),
        Option.getOrNull(Option.map(list.search, (search) => search.toLocaleLowerCase("es-CO"))),
        list.limit
      )
      .toArray();
    return Option.getOrThrow(decodeDashboardTransactions({ rows, categories }));
  });

export const readSqliteDashboardTransactions = ({
  sql,
  userId,
  ranges,
  lists,
  categories,
  accumulation,
}: Readonly<{
  sql: SqlStorage;
  userId: string;
  ranges: ReadonlyArray<Range>;
  lists: ReadonlyArray<DashboardTransactionList>;
  categories: ReadonlyArray<Category>;
  accumulation: "compact" | "bigint";
}>): Effect.Effect<SqliteDashboardTransactions, TransactionAggregatesUnavailable> =>
  Effect.try({
    try: () => ({
      ...fold({ sql, userId, ranges, mode: accumulation }),
      lists: listFacts({ sql, userId, lists, categories }),
    }),
    catch: () => new TransactionAggregatesUnavailable(),
  });
