import { Option, Schema } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { TransactionListLimit, WidgetId } from "../../../src/core/dashboard/contract";
import type { Category } from "../../../src/core/categories/contract";
import { decodeDashboardTransactions } from "./dashboard-query";
import type { DashboardTransactionFact } from "../contract";

const maximumLists = 24;
const maximumListRows = 50;
const Row = Schema.Struct({
  widgetId: WidgetId,
  listLimit: TransactionListLimit,
  transactions: Schema.fromJsonString(
    Schema.Array(Schema.Unknown).check(Schema.isMaxLength(maximumListRows))
  ),
});
export const foldSpanish = (expression: string): string =>
  [
    ["Á", "á"],
    ["É", "é"],
    ["Í", "í"],
    ["Ó", "ó"],
    ["Ú", "ú"],
    ["Ü", "ü"],
    ["Ñ", "ñ"],
  ].reduce((value, [upper, lower]) => `replace(${value},'${upper}','${lower}')`, expression);
const searchText = foldSpanish(
  "coalesce(facts.counterparty,'') || ' ' || coalesce(facts.notes,'')"
);

/** Read bounded lists from authoritative effective facts. Demand projects one live userId, widgetId, categories JSON, search and limit per list. */
export const prepareSelectedDashboardLists = ({
  db,
  demand,
}: Readonly<{ db: D1Database; demand: OwnedStatement }>): Readonly<{
  statement: D1PreparedStatement;
  decode: (
    rows: unknown,
    categories: ReadonlyArray<Category>
  ) => Option.Option<ReadonlyMap<string, ReadonlyArray<DashboardTransactionFact>>>;
}> => ({
  statement: db
    .prepare(`WITH demand AS MATERIALIZED (${demand.sql})
    SELECT demand.widgetId, demand.listLimit, coalesce((SELECT json_group_array(json_object(
      'id',id,'amount',amount,'currency',currency,'direction',direction,'counterparty',counterparty,
      'notes',notes,'category_id',category_id,
      'occurred_at',strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch'),
      'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch'),'revision',revision))
    FROM (SELECT facts.* FROM transaction_effective_source facts WHERE facts.user_id = demand.userId
      AND (demand.categories IS NULL OR facts.category_id IN (SELECT value FROM json_each(demand.categories)))
      AND (demand.search IS NULL OR instr(lower(${searchText}),lower(${foldSpanish("demand.search")})) > 0)
      ORDER BY facts.occurred_at_ms DESC, facts.created_at_ms DESC, facts.id DESC LIMIT ${maximumListRows})), '[]') AS transactions
    FROM demand LIMIT ${maximumLists + 1}`)
    .bind(...demand.params),
  decode: (rows, categories) =>
    Option.flatMap(Schema.decodeUnknownOption(Schema.Array(Row))(rows), (decoded) => {
      if (
        decoded.length > maximumLists ||
        new Set(decoded.map((row) => row.widgetId)).size !== decoded.length
      ) {
        return Option.none();
      }
      return Option.map(
        Option.all(
          decoded.map((row) =>
            Option.map(
              decodeDashboardTransactions({
                rows: row.transactions.slice(0, row.listLimit),
                categories,
              }),
              (transactions) => [row.widgetId, transactions] as const
            )
          )
        ),
        (entries) => new Map(entries)
      );
    }),
});
