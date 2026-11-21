import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { listLaunchCategories } from "../../../src/core/categories/operations";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import type { Category } from "../../../src/core/categories/contract";
import {
  type DashboardDocument,
  type DashboardProjectionRange,
  type ProjectedRange,
} from "../../../src/core/dashboard/contract";
import {
  collectLayoutWidgets,
  dashboardProjectionRanges,
} from "../../../src/core/dashboard/operations";
import { type DashboardFacts, DashboardUnavailable } from "../../../src/shell/dashboard/contract";
import type { Budget } from "../../../src/core/budgets/contract";
import type {
  DashboardTransactionList,
  DashboardTransactionSnapshot,
} from "../../transactions/contract";
import { readLocalBudgetCaps } from "../../budgets/operations";
import { readLocalDashboardTransactions } from "../../transactions/operations";

type LayoutWidgets = ReturnType<typeof collectLayoutWidgets>;

type RangePlan = Readonly<{
  plans: ReadonlyArray<Readonly<{ id: string; ranges: ReadonlyArray<DashboardProjectionRange> }>>;
  unique: ReadonlyMap<string, Readonly<{ from: number; toExclusive: number }>>;
}>;

type ListQueries = ReadonlyArray<DashboardTransactionList>;

type ListPlan = Readonly<{
  queries: ListQueries;
  widgets: ReadonlyArray<Readonly<{ id: string; query: number }>>;
}>;

type FinancialSnapshot = DashboardTransactionSnapshot<ReadonlyArray<Budget>>;

const monthLabelLength = 7;

const planRanges = (widgets: LayoutWidgets, now: DateTime.Utc, context: UserContext): RangePlan => {
  const plans = widgets
    .filter((widget) => widget.type !== "transaction-list")
    .map((widget) => ({
      id: widget.id,
      ranges: dashboardProjectionRanges(widget, now, context.timeZone),
    }));

  const unique = new Map<string, Readonly<{ from: number; toExclusive: number }>>();

  for (const plan of plans) {
    for (const range of plan.ranges) unique.set(`${range.from}:${range.toExclusive}`, range);
  }

  return { plans, unique };
};

const planLists = (widgets: LayoutWidgets): ListPlan => {
  const queries: Array<ListQueries[number]> = [];
  const selected: Array<Readonly<{ id: string; query: number }>> = [];
  const positions = new Map<string, number>();

  for (const widget of widgets) {
    if (widget.type !== "transaction-list") continue;
    const categories = widget.categories ?? [];
    const key = `${widget.limit}:${categories.join(",")}:${widget.search ?? ""}`;
    let query = positions.get(key);

    if (query === undefined) {
      query = queries.length;
      positions.set(key, query);
      queries.push({
        categories,
        search: Option.fromUndefinedOr(widget.search),
        limit: widget.limit,
      });
    }

    selected.push({ id: widget.id, query });
  }

  return { queries, widgets: selected };
};

const restoreGroups = (
  plan: RangePlan,
  selected: FinancialSnapshot
): Option.Option<DashboardFacts["groups"]> => {
  if (selected.ranges.length !== plan.unique.size) return Option.none();
  const facts = new Map([...plan.unique.keys()].map((key, index) => [key, selected.ranges[index]]));
  const groups = new Map<string, ReadonlyArray<ProjectedRange>>();

  for (const widget of plan.plans) {
    const buckets: Array<ProjectedRange> = [];

    for (const range of widget.ranges) {
      const contributions = facts.get(`${range.from}:${range.toExclusive}`);

      if (contributions === undefined) return Option.none();
      buckets.push({ key: range.key, contributions });
    }

    groups.set(widget.id, buckets);
  }

  return Option.some(groups);
};

const assembleDashboardFacts = ({
  context,
  categories,
  plan,
  lists,
  selected,
}: Readonly<{
  context: UserContext;
  categories: ReadonlyArray<Category>;
  plan: RangePlan;
  lists: ListPlan;
  selected: FinancialSnapshot;
}>): Option.Option<DashboardFacts> => {
  const groups = restoreGroups(plan, selected);

  const listFacts = Option.all(
    lists.widgets.map((widget) =>
      Option.map(
        Option.fromUndefinedOr(selected.lists[widget.query]),
        (rows) => [widget.id, rows] as const
      )
    )
  );

  if (Option.isNone(groups) || Option.isNone(listFacts)) return Option.none();

  return Option.some({
    context,
    categories: new Map(categories.map((category) => [category.id, category])),
    lists: new Map(listFacts.value),
    budgets: selected.snapshot,
    groups: groups.value,
  });
};

export const localDashboardFacts = Effect.fn(function* (
  user: UserId,
  document: DashboardDocument,
  now: DateTime.Utc
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT service_market AS serviceMarket,locale,time_zone AS timeZone FROM users WHERE id=${user}`;

  const context = yield* Schema.decodeUnknownEffect(UserContext)(row);
  const categories = listLaunchCategories();
  const widgets = collectLayoutWidgets(document.layout);
  const plan = planRanges(widgets, now, context);
  const lists = planLists(widgets);

  const financial = yield* readLocalDashboardTransactions(user, {
    categories,
    lists: lists.queries,
    ranges: [...plan.unique.values()],
  });

  const month = DateTime.formatIsoDate(
    DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(context.timeZone))
  ).slice(0, monthLabelLength);

  const snapshot = yield* readLocalBudgetCaps(user, month);

  return yield* Effect.fromOption(
    assembleDashboardFacts({
      context,
      categories,
      plan,
      lists,
      selected: { ...financial, snapshot },
    }),
    () => new DashboardUnavailable({ cause: undefined })
  );
});
