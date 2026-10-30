import { DateTime, Effect, Option, Schema } from "effect";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import type {
  PlanningTransactionFacts,
  PlanningTransactionRange,
  PlanningTransactionRead,
  PlanningTransactionSnapshot,
} from "../contract";
import { effectiveHistoryPage } from "./effective-transaction";
import { decodeTransactionRow } from "./transaction-history";

const maximumSelection = 128;
const maximumRanges = 2;
const decodeFacts = (rows: ReadonlyArray<unknown>): Option.Option<PlanningTransactionFacts> =>
  Option.map(
    Option.all(rows.slice(0, maximumSelection).map(decodeTransactionRow)),
    (transactions) => ({
      transactions,
      complete: rows.length <= maximumSelection,
    })
  );

const idsStatement = ({
  db,
  userId,
  ids,
}: Readonly<{
  db: D1Database;
  userId: string;
  ids: ReadonlyArray<string>;
}>): D1PreparedStatement => {
  const query = effectiveHistoryPage({
    userId,
    where: `user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    bindings: [userId, ...ids],
    limit: maximumSelection + 1,
  });
  return db.prepare(query.sql).bind(...query.bindings);
};

const rangeStatement = ({
  db,
  userId,
  range,
}: Readonly<{
  db: D1Database;
  userId: string;
  range: PlanningTransactionRange;
}>): Effect.Effect<D1PreparedStatement, Schema.SchemaError> =>
  Effect.gen(function* () {
    const query = effectiveHistoryPage({
      userId,
      where: "user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?",
      bindings: [
        userId,
        DateTime.toEpochMillis(yield* Schema.decodeEffect(UtcTimestamp)(range.from)),
        DateTime.toEpochMillis(yield* Schema.decodeEffect(UtcTimestamp)(range.through)),
      ],
      limit: maximumSelection + 1,
    });
    return db.prepare(query.sql).bind(...query.bindings);
  });

/** Bounded same-User effective facts; the canonical coordinator owns live authority. */
export const readPlanningTransactions = ({
  db,
  userId,
  selection,
}: Readonly<{
  db: D1Database;
  userId: string;
  selection:
    | Readonly<{ kind: "ids"; ids: ReadonlyArray<string> }>
    | (PlanningTransactionRange & Readonly<{ kind: "range" }>);
}>): Effect.Effect<Option.Option<PlanningTransactionFacts>> =>
  Effect.gen(function* () {
    if (selection.kind === "ids" && selection.ids.length === 0) {
      return Option.some({ transactions: [], complete: true });
    }
    if (selection.kind === "ids" && selection.ids.length > maximumSelection) return Option.none();
    const statement =
      selection.kind === "range"
        ? yield* rangeStatement({ db, userId, range: selection })
        : idsStatement({ db, userId, ids: selection.ids });
    const rows = yield* Effect.tryPromise(() => statement.all());
    return decodeFacts(rows.results);
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/** At most two independently capped ranges and the caller's read share one database round trip. */
export const readPlanningTransactionSnapshot = <A>({
  db,
  userId,
  ranges,
  snapshot,
}: PlanningTransactionRead<A>): Effect.Effect<Option.Option<PlanningTransactionSnapshot<A>>> =>
  Effect.gen(function* () {
    if (ranges.length > maximumRanges) return Option.none();
    const statements = yield* Effect.forEach(ranges, (range) =>
      rangeStatement({ db, userId, range })
    );
    const [context, ...pages] = yield* Effect.tryPromise(() =>
      db.batch([snapshot.statement, ...statements])
    );
    if (context === undefined || pages.length !== ranges.length) return Option.none();
    const observed = snapshot.decode(context.results);
    return Option.map(observed, (value) => ({
      snapshot: value,
      ranges: pages.map((page) => decodeFacts(page.results)),
    }));
  }).pipe(Effect.orElseSucceed(() => Option.none()));
