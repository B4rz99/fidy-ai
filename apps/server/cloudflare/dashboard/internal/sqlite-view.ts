import { DateTime, Effect, Option } from "effect";
import type { Category } from "../../../src/core/categories/contract";
import type { DashboardDocument, ProjectedRange } from "../../../src/core/dashboard/contract";
import {
  collectLayoutWidgets,
  dashboardProjectionRanges,
} from "../../../src/core/dashboard/operations";
import type { UserContext } from "../../../src/core/identity/contract";
import type { DashboardView } from "../../../src/shell/dashboard/contract";
import { renderDashboardView } from "../../../src/shell/dashboard/operations";
import { readSqliteBudgetCaps } from "../../budgets/operations";
import type { SqliteDashboardTransactions } from "../../transactions/contract";
import { readSqliteDashboardTransactions } from "../../transactions/operations";

const monthCharacters = 7;
type Input = Readonly<{
  sql: SqlStorage;
  userId: string;
  current: number;
  document: DashboardDocument;
  context: UserContext;
  categories: ReadonlyArray<Category>;
}>;
const rangeGroups = (
  plans: ReadonlyArray<Readonly<{ id: string; ranges: ReadonlyArray<Readonly<{ key: string }>> }>>,
  facts: SqliteDashboardTransactions
): ReadonlyMap<string, ReadonlyArray<ProjectedRange>> => {
  let index = 0;
  return new Map(
    plans.map((plan) => [
      plan.id,
      plan.ranges.map((range) => ({
        key: range.key,
        contributions: Option.getOrThrow(Option.fromUndefinedOr(facts.ranges[index++])),
      })),
    ])
  );
};
/** Entirely synchronous: current layout, interpretation context and cursor facts share their caller's transaction. */
export const sqliteDashboardView = (
  input: Input
): Readonly<{ view: DashboardView; measurement: SqliteDashboardTransactions["measurement"] }> => {
  const now = DateTime.makeUnsafe(input.current);
  const widgets = collectLayoutWidgets(input.document.layout);
  const plans = widgets
    .filter((widget) => widget.type !== "transaction-list")
    .map((widget) => ({
      id: widget.id,
      ranges: dashboardProjectionRanges(widget, now, input.context.timeZone),
    }));
  const lists = widgets.filter((widget) => widget.type === "transaction-list");
  const facts = Effect.runSync(
    readSqliteDashboardTransactions({
      sql: input.sql,
      userId: input.userId,
      categories: input.categories,
      ranges: plans.flatMap((plan) => plan.ranges),
      lists: lists.map((widget) => ({
        categories: widget.categories ?? [],
        search: Option.fromUndefinedOr(widget.search),
        limit: widget.limit,
      })),
      accumulation: "compact",
    })
  );
  const month = DateTime.formatIsoDate(
    DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(input.context.timeZone))
  ).slice(0, monthCharacters);
  const budgets = Option.getOrThrow(
    Effect.runSync(readSqliteBudgetCaps({ sql: input.sql, userId: input.userId, month }))
  );
  const view = Effect.runSync(
    renderDashboardView({
      document: input.document,
      now,
      facts: {
        context: input.context,
        categories: new Map(input.categories.map((category) => [category.id, category])),
        groups: rangeGroups(plans, facts),
        budgets,
        lists: new Map(
          lists.map((widget, index) => [
            widget.id,
            Option.getOrThrow(Option.fromUndefinedOr(facts.lists[index])),
          ])
        ),
      },
    })
  );
  return { view, measurement: facts.measurement };
};
