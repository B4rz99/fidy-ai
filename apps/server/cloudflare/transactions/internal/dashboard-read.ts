import type { TransactionBoundaryFailure } from "../../canonical-work/contract";
import { readFinalizedSnapshot } from "./read-finalization";
import { type Cause, Effect, Option, Schema } from "effect";
import type {
  DashboardTransactionFact,
  DashboardTransactionRead,
  DashboardTransactionSnapshot,
} from "../contract";
import { CategoryId } from "../../../src/core/categories/contract";
import { dashboardTransactionQueries, decodeDashboardTransactions } from "./dashboard-query";
import {
  type AggregateSnapshot,
  aggregateRangesPerBatch,
  decodeAggregateSnapshot,
  maximumAggregateRanges,
  projectionQueries,
  projectionRange,
  projectionSizeQuery,
  revisionSelection,
} from "./dashboard-projection";
import { UserId } from "../../../src/core/identity/contract";
import { prepareConsentAction } from "../../consent/operations";

const maximumFilteredCategories = 16;
const maximumDashboardLists = 24;
const DashboardList = Schema.Struct({
  categories: Schema.Array(CategoryId).check(
    Schema.isMaxLength(maximumFilteredCategories),
    Schema.isUnique()
  ),
  search: Schema.Option(Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(100))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
});
const DashboardLists = Schema.Array(DashboardList).check(Schema.isMaxLength(maximumDashboardLists));

type PreparedRange = Readonly<{
  firstDay: number;
  lastDay: number;
  firstMinute: number;
  lastMinute: number;
}>;
type Chunk = Readonly<{
  aggregate: AggregateSnapshot;
  peers: ReadonlyArray<D1Result>;
  pages: ReadonlyArray<D1Result>;
}>;

const prepareRanges = <A>(
  input: DashboardTransactionRead<A>
): Option.Option<ReadonlyArray<PreparedRange>> => {
  if (
    Option.isNone(Schema.decodeOption(DashboardLists)(input.lists)) ||
    input.ranges.length > maximumAggregateRanges ||
    input.snapshot.statements.length < 1 ||
    input.snapshot.statements.length > 2
  ) {
    return Option.none();
  }
  return Option.all(input.ranges.map(projectionRange));
};

const combinedRowLimit = 16_384;
const ProjectionSize = Schema.Struct({
  row_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type RangePlan = Readonly<{
  revision: Option.Option<number>;
  groups: ReadonlyArray<ReadonlyArray<PreparedRange>>;
}>;

const groupRanges = (
  ranges: ReadonlyArray<PreparedRange>,
  sizes: ReadonlyArray<typeof ProjectionSize.Type>
): ReadonlyArray<ReadonlyArray<PreparedRange>> => {
  const groups: Array<ReadonlyArray<PreparedRange>> = [];
  let selected: Array<PreparedRange> = [];
  let rowCount = 0;
  for (const [index, range] of ranges.entries()) {
    const size = sizes[index];
    if (size === undefined) return [];
    if (
      selected.length >= aggregateRangesPerBatch &&
      rowCount + size.row_count > combinedRowLimit
    ) {
      groups.push(selected);
      selected = [];
      rowCount = 0;
    }
    selected.push(range);
    rowCount += size.row_count;
  }
  if (selected.length > 0) groups.push(selected);
  return groups;
};

const findRangePlan = <A>(
  input: DashboardTransactionRead<A>
): Effect.Effect<Option.Option<RangePlan>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const prepared = prepareRanges(input);
    if (Option.isNone(prepared)) return Option.none();
    const ranges = prepared.value;
    if (ranges.length <= aggregateRangesPerBatch) {
      return Option.some({ revision: Option.none(), groups: [ranges] });
    }
    const { db, userId } = input;
    const rows = yield* Effect.tryPromise(() =>
      db.batch([
        prepareConsentAction({
          db,
          subject: { _tag: "User", userId: UserId.make(userId) },
          requirement: "unrevoked",
          statement: revisionSelection(UserId.make(userId)),
        }),
        ...ranges.map((range) => projectionSizeQuery({ db, userId, range })),
      ])
    );
    if (
      rows.length !== 1 + ranges.length ||
      rows.slice(1).some((row) => row.results.length !== 1)
    ) {
      return Option.none();
    }
    const state = decodeAggregateSnapshot({ rows: rows.slice(0, 1), count: 0 });
    const sizes = Schema.decodeUnknownOption(Schema.Array(ProjectionSize))(
      rows.slice(1).map((row) => row.results[0])
    );
    return Option.isNone(state) || Option.isNone(sizes)
      ? Option.none()
      : Option.some({
          revision: Option.some(state.value.revision),
          groups: groupRanges(ranges, sizes.value),
        });
  });

const validChunkRows = ({
  rows,
  expectedCount,
  aggregateCount,
  accepts,
}: Readonly<{
  rows: ReadonlyArray<D1Result>;
  expectedCount: number;
  aggregateCount: number;
  accepts: (rows: ReadonlyArray<unknown>) => boolean;
}>): boolean => rows.length === expectedCount && accepts(rows[aggregateCount]?.results ?? []);

const readChunk = <A>({
  input,
  ranges,
  first,
  last,
  revision,
}: Readonly<{
  input: DashboardTransactionRead<A>;
  ranges: ReadonlyArray<PreparedRange>;
  first: boolean;
  last: boolean;
  revision: Option.Option<number>;
}>): Effect.Effect<Option.Option<Chunk>, Cause.UnknownError | TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const { db, userId, snapshot, lists } = input;
    const peers = first ? snapshot.statements : snapshot.statements.slice(0, 1);
    const state = revisionSelection(UserId.make(userId));
    const guardedState = Option.isSome(revision)
      ? {
          sql: `SELECT revision,json(CASE WHEN revision=? THEN 'true' ELSE '' END) AS accepted
            FROM (SELECT (SELECT revision FROM (${state.sql})) AS revision) WHERE 1=1`,
          params: [revision.value, ...state.params],
        }
      : state;
    const rows = yield* readFinalizedSnapshot({
      db,
      finalization: last ? input.finalization : Option.none(),
      statements: [
        prepareConsentAction({
          db,
          subject: { _tag: "User", userId: UserId.make(userId) },
          requirement: "unrevoked",
          statement: guardedState,
        }),
        ...ranges.flatMap((range) => projectionQueries({ db, userId, range })),
        ...peers,
        ...(first ? dashboardTransactionQueries({ db, userId, lists }) : []),
      ],
    });
    const aggregateCount = 1 + ranges.length * 2;
    const expectedCount = aggregateCount + peers.length + (first ? lists.length : 0);
    if (!validChunkRows({ rows, expectedCount, aggregateCount, accepts: snapshot.accepts })) {
      return Option.none();
    }
    const aggregate = decodeAggregateSnapshot({
      rows: rows.slice(0, aggregateCount),
      count: ranges.length,
    });
    return Option.map(aggregate, (observed) => ({
      aggregate: observed,
      peers: rows.slice(aggregateCount, aggregateCount + peers.length),
      pages: rows.slice(aggregateCount + peers.length),
    }));
  });

const decodeFirstChunk = <A>({
  input,
  chunk,
}: Readonly<{ input: DashboardTransactionRead<A>; chunk: Chunk }>): Effect.Effect<
  Option.Option<DashboardTransactionSnapshot<A>>
> =>
  Effect.gen(function* () {
    const observed = yield* input.snapshot.decode(chunk.peers);
    if (Option.isNone(observed)) return Option.none();
    const lists = Option.all(
      input.lists.map((list, index) => {
        const page = chunk.pages[index];
        return page === undefined || page.results.length > list.limit
          ? Option.none<ReadonlyArray<DashboardTransactionFact>>()
          : decodeDashboardTransactions({ rows: page.results, categories: input.categories });
      })
    );
    return Option.map(lists, (selected) => ({
      snapshot: observed.value,
      lists: selected,
      ranges: chunk.aggregate.values,
    }));
  });

/**
 * Read lists, exact ranges and owner facts under current Consent and one fact revision.
 * Wider groups stay within a raw-row budget; larger working sets keep four-range chunks.
 * Each group repeats the owner proof; a changed revision withholds the whole read.
 * Revision disagreement aborts a later native unit, including its final accounting. The caller
 * supplies no reusable authority; read assembly does not require a User coordinator turn.
 */
export const readDashboardTransactions = <A>(
  input: DashboardTransactionRead<A>
): Effect.Effect<Option.Option<DashboardTransactionSnapshot<A>>> =>
  Effect.gen(function* () {
    const plan = yield* findRangePlan(input);
    if (Option.isNone(plan)) return Option.none();
    let result = Option.none<DashboardTransactionSnapshot<A>>();
    let revision = plan.value.revision;
    for (const [index, ranges] of plan.value.groups.entries()) {
      const chunk = yield* readChunk({
        input,
        ranges,
        first: index === 0,
        last: index === plan.value.groups.length - 1,
        revision,
      });
      if (
        Option.isNone(chunk) ||
        (Option.isSome(revision) && revision.value !== chunk.value.aggregate.revision)
      ) {
        return Option.none();
      }
      revision = Option.some(chunk.value.aggregate.revision);
      result = Option.isNone(result)
        ? yield* decodeFirstChunk({ input, chunk: chunk.value })
        : Option.some({
            ...result.value,
            ranges: [...result.value.ranges, ...chunk.value.aggregate.values],
          });
      if (Option.isNone(result)) return Option.none();
    }
    return result;
  }).pipe(Effect.orElseSucceed(() => Option.none()));
