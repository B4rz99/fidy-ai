import { Effect, Option, Schema } from "effect";

import { IanaTimeZone, Locale, ServiceMarket } from "../../src/core/_shared/context";
import { Category } from "../../src/core/categories/model";
import { type DashboardDocument, collectLayoutWidgets } from "../../src/core/dashboard/model";
import type { DashboardFacts } from "../../src/shell/dashboard/presentation";
import { listOwnedBudgets } from "../budgets/budget-queries";
import {
  dashboardTransactionQueries,
  decodeDashboardTransactions,
  maximumDashboardAggregateFacts,
} from "../transactions/dashboard-query";

const UserContextRow = Schema.Struct({
  service_market: ServiceMarket,
  locale: Locale,
  time_zone: IanaTimeZone,
});
const decodeFacts = (
  input: Readonly<{
    userResult: D1Result<unknown>;
    categories: D1Result<unknown>;
    budgets: DashboardFacts["budgets"];
    transactions: D1Result<unknown>;
    lists: ReadonlyArray<Readonly<{ id: string; result: D1Result<unknown> }>>;
  }>
): Option.Option<DashboardFacts> => {
  const context = Schema.decodeUnknownOption(UserContextRow)(input.userResult.results[0]);
  if (
    Option.isNone(context) ||
    input.transactions.results.length > maximumDashboardAggregateFacts
  ) {
    return Option.none();
  }
  const categories = Option.all(
    input.categories.results.map((raw) => Schema.decodeUnknownOption(Category)(raw))
  );
  const transactions = decodeDashboardTransactions(input.transactions.results);
  const lists = Option.all(
    input.lists.map(({ id, result }) =>
      Option.map(decodeDashboardTransactions(result.results), (rows) => [id, rows] as const)
    )
  );
  return Option.map(Option.all({ categories, transactions, lists }), (facts) => ({
    ...facts,
    budgets: input.budgets,
    lists: new Map(facts.lists),
    categories: new Map(facts.categories.map((category) => [category.id, category])),
    context: context.value,
  }));
};

/** Fail closed when current aggregate facts exceed the interim work budget; lists always query a page. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const loadDashboardFacts = (
  db: D1Database,
  userId: string,
  document: DashboardDocument
): Effect.Effect<Option.Option<DashboardFacts>> =>
  Effect.gen(function* () {
    const widgets = collectLayoutWidgets(document.layout);
    const lists = widgets.filter((widget) => widget.type === "transaction-list");
    const needsTotals = widgets.some((widget) => widget.type !== "transaction-list");
    const [userResult, categories, transactions, ...listResults] = yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?").bind(userId),
        db.prepare("SELECT id, label FROM categories ORDER BY display_order LIMIT 32"),
        ...dashboardTransactionQueries({
          db,
          userId,
          needsTotals,
          lists: lists.map((widget) => ({
            categories: widget.categories ?? [],
            search: Option.fromUndefinedOr(widget.search),
            limit: widget.limit,
          })),
        }),
      ])
    );
    if (
      userResult === undefined ||
      categories === undefined ||
      transactions === undefined ||
      listResults.length !== lists.length
    ) {
      return Option.none();
    }
    const listPairs = lists.flatMap((widget, index) => {
      const result = listResults[index];
      return result === undefined ? [] : [{ id: widget.id, result }];
    });
    const budgets = yield* listOwnedBudgets({ db, userId });
    return Option.isSome(budgets)
      ? decodeFacts({
          userResult,
          categories,
          budgets: budgets.value,
          transactions,
          lists: listPairs,
        })
      : Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));
