import { understoodCategory } from "./sqlite-history";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { readFinalizedSnapshot } from "./read-finalization";
import { DateTime, Effect, Option, Schema } from "effect";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import type {
  PlanningTransactionFacts,
  PlanningTransactionRange,
  PlanningTransactionRead,
  PlanningTransactionSnapshot,
} from "../contract";
import type { Transaction } from "../../../src/core/transactions/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type effectiveHistoryPage, selectedEffectiveHistoryPage } from "./effective-transaction";
import { decodeTransactionRow } from "./transaction-history";

const maximumSelection = 128;
const maximumRanges = 2;
const maximumReferences = 4096;
const decodeFacts = (rows: ReadonlyArray<unknown>): Option.Option<PlanningTransactionFacts> =>
  Option.map(
    Option.all(rows.slice(0, maximumSelection).map(decodeTransactionRow)),
    (transactions) => ({
      transactions,
      complete: rows.length <= maximumSelection,
    })
  );

const idsPage = (
  userId: string,
  ids: ReadonlyArray<string>,
  taxonomyRevision = false
): ReturnType<typeof effectiveHistoryPage> =>
  selectedEffectiveHistoryPage({
    userSelection: { sql: "SELECT ? AS userId", params: [userId] },
    taxonomyRevision,
    where: "user_id = ? AND id IN (SELECT value FROM json_each(?))",
    bindings: [userId, Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(ids)],
    limit: maximumSelection + 1,
  });
const rangePage = Effect.fn(function* (
  userId: string,
  range: PlanningTransactionRange,
  taxonomyRevision: boolean
) {
  return selectedEffectiveHistoryPage({
    userSelection: { sql: "SELECT ? AS userId", params: [userId] },
    taxonomyRevision,
    where: "user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?",
    bindings: [
      userId,
      DateTime.toEpochMillis(yield* Schema.decodeEffect(UtcTimestamp)(range.from)),
      DateTime.toEpochMillis(yield* Schema.decodeEffect(UtcTimestamp)(range.through)),
    ],
    limit: maximumSelection + 1,
  });
});
const idsStatement = ({
  db,
  userId,
  ids,
}: {
  db: D1Database;
  userId: string;
  ids: ReadonlyArray<string>;
}): D1PreparedStatement => {
  const page = idsPage(userId, ids);
  return db.prepare(page.sql).bind(...page.bindings);
};
const rangeStatement = Effect.fn(function* ({
  db,
  userId,
  range,
}: {
  db: D1Database;
  userId: string;
  range: PlanningTransactionRange;
}) {
  const page = yield* rangePage(userId, range, false);
  return db.prepare(page.sql).bind(...page.bindings);
});
const localFacts = Effect.fn(function* (page: ReturnType<typeof effectiveHistoryPage>) {
  const sql = yield* SqliteClient;
  const rows = yield* sql.unsafe(page.sql, page.bindings);
  const facts = rows.every(understoodCategory)
    ? decodeFacts(rows)
    : Option.none<PlanningTransactionFacts>();
  return yield* Effect.fromOption(facts);
});
export const localPlanningRange = Effect.fn(function* (
  user: string,
  range: PlanningTransactionRange
) {
  return yield* localFacts(yield* rangePage(user, range, true));
});
export const localPlanningReferences = Effect.fn(function* (
  user: string,
  ids: ReadonlyArray<string>
) {
  const transactions: Transaction[] = [];
  for (let offset = 0; offset < ids.length; offset += maximumSelection) {
    const page = idsPage(user, ids.slice(offset, offset + maximumSelection), true);
    const found = yield* localFacts(page);
    transactions.push(...found.transactions);
  }
  return transactions;
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

/** Independently capped ranges, references and the caller's read share one database snapshot. */
export const readPlanningTransactionSnapshot = <A>({
  db,
  userId,
  ranges,
  ids,
  snapshot,
  finalization,
}: PlanningTransactionRead<A>): Effect.Effect<Option.Option<PlanningTransactionSnapshot<A>>> =>
  Effect.gen(function* () {
    if (ranges.length > maximumRanges || ids.length > maximumReferences) return Option.none();
    const statements = yield* Effect.forEach(ranges, (range) =>
      rangeStatement({ db, userId, range })
    );
    const references = [...new Set(ids)];
    const selections: D1PreparedStatement[] = [];
    for (let index = 0; index < references.length; index += maximumSelection) {
      selections.push(
        idsStatement({ db, userId, ids: references.slice(index, index + maximumSelection) })
      );
    }
    const [context, ...pages] = yield* readFinalizedSnapshot({
      db,
      finalization,
      statements: [snapshot.statement, ...statements, ...selections],
    });
    if (context === undefined || pages.length !== ranges.length + selections.length) {
      return Option.none();
    }
    const selected = Option.all(
      pages.slice(ranges.length).map((page) => decodeFacts(page.results))
    ).pipe(
      Option.filter((groups) => groups.every((group) => group.complete)),
      Option.map((groups) => groups.flatMap((group) => group.transactions))
    );
    const observed = snapshot.decode(context.results);
    if (Option.isNone(observed) || Option.isNone(selected)) return Option.none();
    return Option.some({
      snapshot: observed.value,
      ranges: pages.slice(0, ranges.length).map((page) => decodeFacts(page.results)),
      selected: selected.value,
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

type PreparedPlanningFacts = Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  decode: (
    rows: ReadonlyArray<D1Result>,
    references: ReadonlyArray<string>
  ) => Option.Option<
    Readonly<{
      ranges: ReadonlyArray<Option.Option<PlanningTransactionFacts>>;
      selected: ReadonlyArray<Transaction>;
    }>
  >;
}>;

const orderedReferences = (
  rows: ReadonlyArray<unknown>,
  ids: ReadonlyArray<string>
): Option.Option<ReadonlyArray<Transaction>> => {
  const references = [...new Set(ids)];
  if (references.length > maximumReferences || rows.length > maximumReferences) {
    return Option.none();
  }
  const groups: Transaction[][] = Array.from(
    { length: Math.ceil(references.length / maximumSelection) },
    () => []
  );
  const positions = new Map(
    references.map((id, index) => [id, Math.floor(index / maximumSelection)])
  );
  const decoded = Option.all(rows.map(decodeTransactionRow));
  if (Option.isNone(decoded)) return Option.none();
  for (const transaction of decoded.value) {
    const index = positions.get(transaction.id);
    const group = index === undefined ? undefined : groups[index];
    if (group === undefined || group.length >= maximumSelection) return Option.none();
    group.push(transaction);
  }
  return Option.some(groups.flat());
};

/** Prepare independently capped matching windows and all bounded linked facts in one snapshot.
 * Range-only eligibility stays separate from the linked facts' live User proof.
 * Decoding restores the existing 128-reference group order without repeating selection per group.
 */
export const prepareBoundPlanningTransactions = ({
  db,
  rangeUsers,
  referenceUsers,
  references,
  ranges,
}: Readonly<{
  db: D1Database;
  rangeUsers: OwnedStatement;
  referenceUsers: OwnedStatement;
  references: OwnedStatement;
  ranges: ReadonlyArray<PlanningTransactionRange>;
}>): Option.Option<PreparedPlanningFacts> => {
  if (ranges.length > maximumRanges) return Option.none();
  const decoded = Option.all(
    ranges.map((range) =>
      Option.zipWith(
        Schema.decodeOption(UtcTimestamp)(range.from),
        Schema.decodeOption(UtcTimestamp)(range.through),
        (from, through) => ({ from, through })
      )
    )
  );
  if (Option.isNone(decoded)) return Option.none();
  const windows = decoded.value.map(({ from, through }) =>
    selectedEffectiveHistoryPage({
      userSelection: rangeUsers,
      where:
        "user_id=(SELECT userId FROM transaction_history_user) AND occurred_at_ms >= ? AND occurred_at_ms < ?",
      bindings: [DateTime.toEpochMillis(from), DateTime.toEpochMillis(through)],
      limit: maximumSelection + 1,
    })
  );
  const linked = selectedEffectiveHistoryPage({
    userSelection: referenceUsers,
    where: `user_id=(SELECT userId FROM transaction_history_user) AND id IN (SELECT transactionId FROM (${references.sql}))`,
    bindings: references.params,
    limit: maximumReferences + 1,
  });
  const query = {
    ...linked,
    sql: linked.sql.replace(
      "FROM transaction_projection_leaf\n",
      "FROM transaction_projection_leaf INDEXED BY sqlite_autoindex_transaction_projection_leaf_1\n"
    ),
  };
  return Option.some({
    statements: [...windows, query].map(({ sql, bindings }) => db.prepare(sql).bind(...bindings)),
    decode: (rows, ids) => {
      const selected = rows[windows.length];
      if (rows.length !== windows.length + 1 || selected === undefined) return Option.none();
      return Option.map(orderedReferences(selected.results, ids), (facts) => ({
        ranges: rows.slice(0, windows.length).map((row) => decodeFacts(row.results)),
        selected: facts,
      }));
    },
  });
};
