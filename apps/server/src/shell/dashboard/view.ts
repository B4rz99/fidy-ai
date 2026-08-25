import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type BudgetStatus, BudgetStatusQuery } from "~/core/budgets/model";
import { deriveCurrentBudgetMonth } from "~/core/budgets/rules";
import {
  dashboardMoneyGroupsFromMetrics,
  dashboardMoneyGroupsFromSums,
  resolveDashboardPeriod,
} from "~/core/dashboard/calculation";
import type {
  AppliedDashboardPeriod,
  DashboardDocument,
  DashboardQueryContext,
  LayoutNode,
  Widget,
  WidgetId,
} from "~/core/dashboard/model";
import { normalizeSearchText } from "~/core/_shared/search";
import type { Category } from "~/core/categories/model";
import type { CategoryId } from "~/core/categories/reference";
import type { UserId } from "~/core/identity/reference";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { OperationResponse } from "~/shell/_shared/response";
import { selectBudgetStatusesInScope } from "~/shell/budgets/repo";
import { selectCategoriesByIds, selectCategoriesMatching } from "~/shell/categories/repo";
import { findUserInScope } from "~/shell/identity/repo";
import {
  type DashboardTransactionMetricFact,
  type DashboardTransactionSumFact,
  selectDashboardTransactionMetricsInScope,
  selectDashboardTransactionSumsInScope,
  selectDashboardTransactionsInScope,
} from "~/shell/transactions/repo";
import { loadOrCreateDashboard } from "./mutations";
import { DashboardView, type DashboardWidgetView } from "./operations";
import { withDashboardLockInScope } from "./repo";

type ViewResponse = ReturnType<typeof OperationResponse<typeof DashboardView>>["Type"];
type ViewContext = DashboardView["context"];
type ViewLayout = DashboardView["layout"];
type WidgetViewById = ReadonlyMap<WidgetId, DashboardWidgetView>;
type CategoryById = ReadonlyMap<CategoryId, Category>;
type DashboardAcquisitionContext = Readonly<{
  userId: UserId;
  now: DateTime.Utc;
  categories: CategoryById;
}>;
type AcquiredEntries = ReadonlyArray<readonly [WidgetId, DashboardWidgetView]>;
type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type SpendingFact = Readonly<{
  key: SpendingResult["buckets"][number]["key"];
  direction: "inflow" | "outflow";
  money: DashboardTransactionSumFact["money"];
}>;
type BudgetResult = Extract<DashboardWidgetView["result"], { readonly availability: unknown }>;
type AvailableBudgetResult = Extract<BudgetResult, { readonly availability: "available" }>;
type SplitViewLayout = Extract<ViewLayout, { readonly kind: "split" }>;
type Consumers<WidgetType> = [WidgetType, ...Array<WidgetType>];

type SpendingWidget = Extract<Widget, { readonly type: "spending-chart" }>;
type MetricWidget = Extract<Widget, { readonly type: "custom-metric" }>;
type ListWidget = Extract<Widget, { readonly type: "transaction-list" }>;
type BudgetWidget = Extract<Widget, { readonly type: "budget-bar" }>;

type SpendingNeed = {
  readonly key: string;
  readonly consumers: Consumers<SpendingWidget>;
  readonly appliedPeriod: AppliedDashboardPeriod;
};
type MetricNeed = {
  readonly key: string;
  readonly consumers: Consumers<MetricWidget>;
  readonly appliedPeriod: AppliedDashboardPeriod;
};
type ListNeed = { readonly key: string; readonly consumers: Consumers<ListWidget> };
type BudgetNeed = {
  readonly key: string;
  readonly consumers: Consumers<BudgetWidget>;
  readonly appliedPeriod: AppliedDashboardPeriod;
};
type DashboardPlan = Readonly<{
  spending: ReadonlyArray<SpendingNeed>;
  metrics: ReadonlyArray<MetricNeed>;
  lists: ReadonlyArray<ListNeed>;
  budgets: ReadonlyArray<BudgetNeed>;
}>;

const dashboardProjectionTimeout = "6 seconds";

const authenticatedUserMissing = (userId: UserId) => (): Error =>
  new Error(`Authenticated User ${userId} is missing`);
const missingCategory = (widgetId: WidgetId) => (): Error =>
  new Error(`Dashboard Widget ${widgetId} references a missing Category`);
const missingWidgetView = (widgetId: WidgetId): Error =>
  new Error(`Dashboard acquisition omitted Widget ${widgetId}`);

const categoryIds = (
  widget: SpendingWidget | MetricWidget | ListWidget
): ReadonlyArray<CategoryId> =>
  widget.categories === undefined ? [] : [...widget.categories].sort();
const categoryKey = (widget: SpendingWidget | MetricWidget | ListWidget): string =>
  categoryIds(widget).join(",");
const periodKey = (period: AppliedDashboardPeriod): string =>
  `${period.from.epochMilliseconds}:${period.toExclusive.epochMilliseconds}:${period.timeZone}`;
const listKey = (widget: ListWidget): string =>
  `${categoryKey(widget)}:${widget.search === undefined ? "" : normalizeSearchText(widget.search)}:${widget.limit}`;

const appendConsumer = <
  Consumer,
  Need extends Readonly<{ key: string; consumers: Array<Consumer> }>,
>({
  needs,
  key,
  consumer,
  make,
}: Readonly<{
  needs: Array<Need>;
  key: string;
  consumer: Consumer;
  make: () => Need;
}>): void => {
  const current = needs.find((need) => need.key === key);
  if (current === undefined) needs.push(make());
  else current.consumers.push(consumer);
};

const compileDashboardPlan = (
  document: DashboardDocument,
  context: DashboardQueryContext,
  now: DateTime.Utc
): DashboardPlan => {
  const spending: Array<SpendingNeed> = [];
  const metrics: Array<MetricNeed> = [];
  const lists: Array<ListNeed> = [];
  const budgets: Array<BudgetNeed> = [];
  const visit = (node: LayoutNode): void => {
    if (node.kind === "split") {
      for (const child of node.children) visit(child.node);
      return;
    }
    const widget = node.widget;
    if (widget.type === "transaction-list") {
      const key = listKey(widget);
      appendConsumer({
        needs: lists,
        key,
        consumer: widget,
        make: () => ({ key, consumers: [widget] }),
      });
      return;
    }
    const period = resolveDashboardPeriod({
      now,
      period: widget.type === "budget-bar" ? "this-month" : widget.period,
      timeZone: context.timeZone,
    });
    if (widget.type === "spending-chart") {
      const key = `${widget.groupBy}:${categoryKey(widget)}:${periodKey(period)}`;
      appendConsumer({
        needs: spending,
        key,
        consumer: widget,
        make: () => ({ key, consumers: [widget], appliedPeriod: period }),
      });
    } else if (widget.type === "custom-metric") {
      const key = `${widget.aggregation}:${categoryKey(widget)}:${periodKey(period)}`;
      appendConsumer({
        needs: metrics,
        key,
        consumer: widget,
        make: () => ({ key, consumers: [widget], appliedPeriod: period }),
      });
    } else {
      const key = `${widget.categoryId}:${widget.currency}:${periodKey(period)}`;
      appendConsumer({
        needs: budgets,
        key,
        consumer: widget,
        make: () => ({ key, consumers: [widget], appliedPeriod: period }),
      });
    }
  };
  visit(document.layout);
  return { spending, metrics, lists, budgets };
};

const categoryReferences = (plan: DashboardPlan): ReadonlyMap<CategoryId, WidgetId> => {
  const references = new Map<CategoryId, WidgetId>();
  for (const needs of [plan.spending, plan.metrics, plan.lists]) {
    for (const need of needs) {
      const widget = need.consumers[0];
      for (const categoryId of categoryIds(widget)) references.set(categoryId, widget.id);
    }
  }
  for (const need of plan.budgets) {
    const widget = need.consumers[0];
    references.set(widget.categoryId, widget.id);
  }
  return references;
};

const loadRequiredCategories = (
  plan: DashboardPlan
): Effect.Effect<CategoryById, never, SqlClient.SqlClient> => {
  const references = categoryReferences(plan);
  return selectCategoriesByIds([...references.keys()]).pipe(
    Effect.map(
      (categories) =>
        new Map(
          categories.map((category): readonly [CategoryId, Category] => [category.id, category])
        )
    ),
    Effect.tap((categories) =>
      Effect.sync(() => {
        for (const [categoryId, widgetId] of references) {
          if (!categories.has(categoryId)) throw missingCategory(widgetId)();
        }
      })
    ),
    Effect.orDie
  );
};

const bucketIdentity = (fact: SpendingFact): string => {
  switch (fact.key.kind) {
    case "category":
      return `category:${fact.key.category.id}`;
    case "day":
      return `day:${fact.key.date}`;
    case "month":
      return `month:${fact.key.month}`;
  }
};

const spendingBuckets = (facts: ReadonlyArray<SpendingFact>): SpendingResult["buckets"] => {
  const buckets = new Map<string, { key: SpendingFact["key"]; facts: Array<SpendingFact> }>();
  for (const fact of facts) {
    const id = bucketIdentity(fact);
    const bucket = buckets.get(id) ?? { key: fact.key, facts: [] };
    bucket.facts.push(fact);
    buckets.set(id, bucket);
  }
  return [...buckets.values()].map(({ key, facts: sums }) => ({
    key,
    moneyGroups: dashboardMoneyGroupsFromSums(sums),
  }));
};

const acquireSpending = (
  userId: UserId,
  need: SpendingNeed
): Effect.Effect<AcquiredEntries, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const first = need.consumers[0];
    const acquired = yield* selectDashboardTransactionSumsInScope(userId, {
      ...need.appliedPeriod,
      categories: categoryIds(first),
      groupBy: first.groupBy,
      timeZone: need.appliedPeriod.timeZone,
    });
    let facts: ReadonlyArray<SpendingFact>;
    if (first.groupBy === "category") {
      const categories = yield* selectCategoriesByIds(
        acquired.flatMap(({ key }) => (key.kind === "category" ? [key.categoryId] : []))
      );
      facts = categories.flatMap((category) =>
        acquired.flatMap((fact): ReadonlyArray<SpendingFact> =>
          fact.key.kind === "category" && fact.key.categoryId === category.id
            ? [{ ...fact, key: { kind: "category", category } }]
            : []
        )
      );
      if (facts.length !== acquired.length) throw missingCategory(first.id)();
    } else {
      facts = acquired.map((fact): SpendingFact => {
        if (fact.key.kind === "category") throw new Error("Unexpected Category grouping");
        return { ...fact, key: fact.key };
      });
    }
    const result = { appliedPeriod: need.appliedPeriod, buckets: spendingBuckets(facts) };
    return need.consumers.map((widget): readonly [WidgetId, DashboardWidgetView] => [
      widget.id,
      { widget, result },
    ]);
  });

const acquireMetrics = (
  userId: UserId,
  need: MetricNeed
): Effect.Effect<AcquiredEntries, never, SqlClient.SqlClient> =>
  selectDashboardTransactionMetricsInScope(userId, {
    ...need.appliedPeriod,
    aggregation: need.consumers[0].aggregation,
    categories: categoryIds(need.consumers[0]),
  }).pipe(
    Effect.map((facts: ReadonlyArray<DashboardTransactionMetricFact>) =>
      need.consumers.map((widget): readonly [WidgetId, DashboardWidgetView] => [
        widget.id,
        {
          widget,
          result: {
            appliedPeriod: need.appliedPeriod,
            moneyGroups: dashboardMoneyGroupsFromMetrics(facts),
          },
        },
      ])
    )
  );

const acquireList = (
  userId: UserId,
  need: ListNeed
): Effect.Effect<AcquiredEntries, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const widget = need.consumers[0];
    const search = Option.fromUndefinedOr(widget.search).pipe(Option.map(normalizeSearchText));
    const matchingCategories = Option.isSome(search)
      ? yield* selectCategoriesMatching(search.value)
      : [];
    const facts = yield* selectDashboardTransactionsInScope(userId, {
      categories: categoryIds(widget),
      search,
      searchCategoryIds: matchingCategories.map(({ id }) => id),
      limit: widget.limit,
    });
    const categories = yield* selectCategoriesByIds(facts.map(({ categoryId }) => categoryId));
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const transactions = facts.map(({ categoryId, ...transaction }) => {
      const category = categoryById.get(categoryId);
      if (category === undefined) throw missingCategory(widget.id)();
      return { ...transaction, category };
    });
    return need.consumers.map((consumer): readonly [WidgetId, DashboardWidgetView] => [
      consumer.id,
      { widget: consumer, result: { transactions } },
    ]);
  });

/** Projects the closed Budget status without leaking persistence facts. */
export const budgetStatusResult = (status: BudgetStatus): AvailableBudgetResult["status"] => {
  switch (status.type) {
    case "under":
      return { type: "under", remaining: status.remaining };
    case "reached":
      return { type: "reached" };
    case "over":
      return { type: "over", overBy: status.overBy };
  }
};

const acquireBudget = (
  context: DashboardAcquisitionContext,
  need: BudgetNeed
): Effect.Effect<AcquiredEntries, never, SqlClient.SqlClient> => {
  const widget = need.consumers[0];
  const category = context.categories.get(widget.categoryId);
  if (category === undefined) return Effect.die(missingCategory(widget.id)());
  const period = deriveCurrentBudgetMonth({
    now: context.now,
    timeZone: need.appliedPeriod.timeZone,
  });
  return selectBudgetStatusesInScope(
    context.userId,
    BudgetStatusQuery.make({
      categoryId: Option.some(widget.categoryId),
      currency: Option.some(widget.currency),
      timeZone: need.appliedPeriod.timeZone,
    }),
    period
  ).pipe(
    Effect.orDie,
    Effect.map((statuses) => {
      const status = statuses[0];
      const result: BudgetResult =
        status === undefined
          ? {
              availability: "missing-budget",
              appliedPeriod: need.appliedPeriod,
              category,
              currency: widget.currency,
            }
          : {
              availability: "available",
              appliedPeriod: need.appliedPeriod,
              category,
              currency: widget.currency,
              cap: status.budget.cap,
              spent: status.spent,
              status: budgetStatusResult(status),
            };
      return need.consumers.map((consumer): readonly [WidgetId, DashboardWidgetView] => [
        consumer.id,
        { widget: consumer, result },
      ]);
    })
  );
};

const acquireDashboardPlan = (
  context: DashboardAcquisitionContext,
  plan: DashboardPlan
): Effect.Effect<WidgetViewById, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const groups = yield* Effect.all([
      Effect.forEach(plan.spending, (need) => acquireSpending(context.userId, need)),
      Effect.forEach(plan.metrics, (need) => acquireMetrics(context.userId, need)),
      Effect.forEach(plan.lists, (need) => acquireList(context.userId, need)),
      Effect.forEach(plan.budgets, (need) => acquireBudget(context, need)),
    ]);
    const views = new Map<WidgetId, DashboardWidgetView>();
    for (const family of groups) {
      for (const entries of family) {
        for (const [widgetId, view] of entries) views.set(widgetId, view);
      }
    }
    return views;
  });

const enrichLayout = (node: LayoutNode, views: WidgetViewById): ViewLayout => {
  if (node.kind === "leaf") {
    const widget = views.get(node.widget.id);
    if (widget === undefined) throw missingWidgetView(node.widget.id);
    return { kind: "leaf", widget };
  }
  const [first, second, ...rest] = node.children;
  const firstChild = { weight: first.weight, node: enrichLayout(first.node, views) };
  const secondChild = { weight: second.weight, node: enrichLayout(second.node, views) };
  const children: SplitViewLayout["children"] = [
    firstChild,
    secondChild,
    ...rest.map(({ node: child, weight }) => ({
      weight,
      node: enrichLayout(child, views),
    })),
  ];
  return { kind: "split", axis: node.axis, children };
};

/**
 * Returns one complete current-context projection of the caller's decoded DashboardDocument.
 * Shared canonical-operation telemetry observes this boundary for both HTTP and hosted callers;
 * this service adds no second failure report.
 */
export const getDashboardView: CanonicalMutationImplementation<
  Readonly<{ userId: UserId }>,
  ViewResponse,
  never
> = Effect.fn("getDashboardView")(function* ({ userId }) {
  const projection = withDashboardLockInScope(
    userId,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SET LOCAL statement_timeout = '5s'`.pipe(Effect.orDie);
      const document = yield* loadOrCreateDashboard(userId);
      const user = yield* findUserInScope(userId).pipe(
        Effect.flatMap(Effect.fromOption(authenticatedUserMissing(userId))),
        Effect.orDie
      );
      const now = yield* DateTime.now;
      const queryContext: DashboardQueryContext = {
        serviceMarket: user.serviceMarket,
        locale: user.locale,
        timeZone: user.timeZone,
      };
      const context: ViewContext = { ...queryContext, calculatedAt: now };
      const plan = compileDashboardPlan(document, queryContext, now);
      const categories = yield* loadRequiredCategories(plan);
      const views = yield* acquireDashboardPlan({ userId, now, categories }, plan);
      const view = DashboardView.make({
        title: document.title,
        context,
        layout: enrichLayout(document.layout, views),
      });
      yield* Schema.encodeEffect(DashboardView)(view).pipe(Effect.orDie);
      return view;
    })
  );
  const data = yield* projection.pipe(
    Effect.timeoutOrElse({
      duration: dashboardProjectionTimeout,
      orElse: () => Effect.die(new Error("Dashboard projection exceeded its deadline.")),
    })
  );
  return { data, next: [] };
});
