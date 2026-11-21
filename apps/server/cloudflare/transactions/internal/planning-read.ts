import { understoodCategory } from "./sqlite-history";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Array as Arr, DateTime, Effect, Option, Schema } from "effect";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import type { PlanningTransactionFacts, PlanningTransactionRange } from "../contract";
import type { Transaction } from "../../../src/core/transactions/contract";
import { type effectiveHistoryPage, selectedEffectiveHistoryPage } from "./effective-transaction";
import { decodeTransactionRow } from "./transaction-history";

const maximumSelection = 128;

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
  const pages = yield* Effect.forEach(Arr.chunksOf(ids, maximumSelection), (selection) =>
    localFacts(idsPage(user, selection, true))
  );

  return pages.flatMap((found): Transaction[] => [...found.transactions]);
});
