import { Data, type DateTime, Effect, Option } from "effect";

import type { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import type { Category } from "~/core/categories/contract";
import { type Budget, calculateBudgetStatus } from "~/shell/budgets/contract";
import { resolveDashboardPeriod } from "~/core/dashboard/calculation";
import {
  type ProjectedRange,
  projectAggregateBudgetSpent,
  projectAggregateChart,
  projectAggregateMetric,
} from "~/core/dashboard/aggregation";
import { type DashboardDocument, type LayoutNode, type Widget } from "~/core/dashboard/model";
import type { Transaction } from "~/shell/transactions/contract";
import { type DashboardView, type DashboardWidgetView } from "./operations";

class DashboardUnavailable extends Data.TaggedError("DashboardUnavailable") {}

/** Decoded User-owned facts supplied by the storage adapter for one Dashboard projection. */
export type DashboardFacts = Readonly<{
  groups: ReadonlyMap<string, ReadonlyArray<ProjectedRange>>;
  lists: ReadonlyMap<
    string,
    ReadonlyArray<Readonly<{ transaction: Transaction; category: Category }>>
  >;
  budgets: ReadonlyArray<Budget>;
  categories: ReadonlyMap<string, Category>;
  context: Readonly<{
    service_market: ServiceMarket;
    locale: Locale;
    time_zone: IanaTimeZone;
  }>;
}>;

type ChartWidget = Extract<Widget, { type: "spending-chart" }>;

const renderChart = (
  widget: ChartWidget,
  facts: DashboardFacts,
  now: DateTime.Utc
): Effect.Effect<DashboardWidgetView, DashboardUnavailable> =>
  Effect.gen(function* () {
    const period = resolveDashboardPeriod({
      now,
      period: widget.period,
      timeZone: facts.context.time_zone,
    });
    const ranges = facts.groups.get(widget.id);
    if (ranges === undefined) return yield* new DashboardUnavailable();
    const buckets = projectAggregateChart({
      widget,
      ranges,
      lookupCategory: (id) => Option.fromUndefinedOr(facts.categories.get(id)),
    });
    if (Option.isNone(buckets)) return yield* new DashboardUnavailable();
    return { widget, result: { appliedPeriod: period, buckets: buckets.value } };
  });

const renderList = (
  widget: Extract<Widget, { type: "transaction-list" }>,
  facts: DashboardFacts
): Effect.Effect<DashboardWidgetView, DashboardUnavailable> =>
  Effect.gen(function* () {
    const rows = facts.lists.get(widget.id);
    if (rows === undefined) return yield* new DashboardUnavailable();
    return {
      widget,
      result: {
        transactions: rows.map(({ transaction, category }) => ({
          id: transaction.id,
          money: transaction.money,
          counterparty: transaction.counterparty,
          direction: transaction.direction,
          category,
          occurredAt: transaction.occurredAt,
        })),
      },
    };
  });

const renderMetric = (
  widget: Extract<Widget, { type: "custom-metric" }>,
  facts: DashboardFacts,
  now: DateTime.Utc
): Effect.Effect<DashboardWidgetView, DashboardUnavailable> =>
  Effect.gen(function* () {
    const period = resolveDashboardPeriod({
      now,
      period: widget.period,
      timeZone: facts.context.time_zone,
    });
    const ranges = facts.groups.get(widget.id);
    if (ranges === undefined) return yield* new DashboardUnavailable();
    return {
      widget,
      result: { appliedPeriod: period, moneyGroups: projectAggregateMetric(widget, ranges) },
    };
  });

const renderBudget = (
  widget: Extract<Widget, { type: "budget-bar" }>,
  facts: DashboardFacts,
  now: DateTime.Utc
): Effect.Effect<DashboardWidgetView, DashboardUnavailable> =>
  Effect.gen(function* () {
    const zone = facts.context.time_zone;
    const period = resolveDashboardPeriod({ now, period: "this-month", timeZone: zone });
    const category = facts.categories.get(widget.categoryId);
    if (category === undefined) return yield* new DashboardUnavailable();
    const budget = facts.budgets.find(
      (entry) => entry.categoryId === widget.categoryId && entry.cap.currency === widget.currency
    );
    if (budget === undefined) {
      return {
        widget,
        result: {
          availability: "missing-budget" as const,
          appliedPeriod: period,
          category,
          currency: widget.currency,
        },
      };
    }
    const ranges = facts.groups.get(widget.id);
    if (ranges === undefined) return yield* new DashboardUnavailable();
    const spent = projectAggregateBudgetSpent(widget, ranges);
    const calculated = yield* calculateBudgetStatus({
      budget,
      spent,
      period: { from: period.from, to: period.toExclusive, timeZone: zone },
    }).pipe(Effect.mapError(() => new DashboardUnavailable()));
    let status: Extract<
      Extract<DashboardWidgetView, { widget: Extract<Widget, { type: "budget-bar" }> }>["result"],
      { availability: "available" }
    >["status"];
    if (calculated.type === "under") status = { type: "under", remaining: calculated.remaining };
    else if (calculated.type === "over") status = { type: "over", overBy: calculated.overBy };
    else status = { type: "reached" };
    return {
      widget,
      result: {
        availability: "available" as const,
        appliedPeriod: period,
        category,
        currency: widget.currency,
        cap: budget.cap,
        spent,
        status,
      },
    };
  });

const renderWidget = (
  widget: Widget,
  facts: DashboardFacts,
  now: DateTime.Utc
): Effect.Effect<DashboardWidgetView, DashboardUnavailable> =>
  Effect.gen(function* () {
    switch (widget.type) {
      case "transaction-list":
        return yield* renderList(widget, facts);
      case "spending-chart":
        return yield* renderChart(widget, facts, now);
      case "custom-metric":
        return yield* renderMetric(widget, facts, now);
      case "budget-bar":
        return yield* renderBudget(widget, facts, now);
    }
  });

/** Rebuild the recursive view from canonical layout, with one typed result at each leaf. */
export const renderDashboardView = ({
  document,
  facts,
  now,
}: Readonly<{
  document: DashboardDocument;
  facts: DashboardFacts;
  now: DateTime.Utc;
}>): Effect.Effect<DashboardView, DashboardUnavailable> => {
  const render = (
    node: LayoutNode
  ): Effect.Effect<DashboardView["layout"], DashboardUnavailable> =>
    node.kind === "leaf"
      ? renderWidget(node.widget, facts, now).pipe(
          Effect.map((widget) => ({ kind: "leaf" as const, widget }))
        )
      : Effect.forEach(node.children, (child) =>
          render(child.node).pipe(
            Effect.map((rendered) => ({ weight: child.weight, node: rendered }))
          )
        ).pipe(
          Effect.map(([first, second, ...rest]) => ({
            kind: "split" as const,
            axis: node.axis,
            children: [
              Option.getOrThrow(Option.fromUndefinedOr(first)),
              Option.getOrThrow(Option.fromUndefinedOr(second)),
              ...rest,
            ],
          }))
        );
  return render(document.layout).pipe(
    Effect.map((layout) => ({
      title: document.title,
      layout,
      context: {
        serviceMarket: facts.context.service_market,
        locale: facts.context.locale,
        timeZone: facts.context.time_zone,
        calculatedAt: now,
      },
    }))
  );
};
