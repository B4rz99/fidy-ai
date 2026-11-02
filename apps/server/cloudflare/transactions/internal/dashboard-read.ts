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

const readChunk = <A>({
  input,
  ranges,
  first,
}: Readonly<{
  input: DashboardTransactionRead<A>;
  ranges: ReadonlyArray<PreparedRange>;
  first: boolean;
}>): Effect.Effect<Option.Option<Chunk>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { db, userId, snapshot, lists } = input;
    const peers = first ? snapshot.statements : snapshot.statements.slice(0, 1);
    const rows = yield* Effect.tryPromise(() =>
      db.batch([
        prepareConsentAction({
          db,
          subject: { _tag: "User", userId: UserId.make(userId) },
          requirement: "unrevoked",
          statement: revisionSelection(UserId.make(userId)),
        }),
        ...ranges.flatMap((range) => projectionQueries({ db, userId, range })),
        ...peers,
        ...(first ? dashboardTransactionQueries({ db, userId, lists }) : []),
      ])
    );
    const aggregateCount = 1 + ranges.length * 2;
    const expectedCount = aggregateCount + peers.length + (first ? lists.length : 0);
    if (rows.length !== expectedCount || !snapshot.accepts(rows[aggregateCount]?.results ?? [])) {
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
 * Each bounded chunk repeats the owner proof; any unavailable chunk withholds the whole read.
 * The caller retains the same User's coordinator turn and supplies no reusable authority.
 */
export const readDashboardTransactions = <A>(
  input: DashboardTransactionRead<A>
): Effect.Effect<Option.Option<DashboardTransactionSnapshot<A>>> =>
  Effect.gen(function* () {
    const prepared = prepareRanges(input);
    if (Option.isNone(prepared)) return Option.none();
    let result = Option.none<DashboardTransactionSnapshot<A>>();
    let revision = Option.none<number>();
    // Empty range selections still read readiness, caller facts and bounded lists once.
    for (
      let offset = 0;
      offset < Math.max(1, prepared.value.length);
      offset += aggregateRangesPerBatch
    ) {
      const chunk = yield* readChunk({
        input,
        ranges: prepared.value.slice(offset, offset + aggregateRangesPerBatch),
        first: offset === 0,
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
