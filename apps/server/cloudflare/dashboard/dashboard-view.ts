import { Data, type DateTime, Effect, Option, Schema } from "effect";

import { Money } from "../../src/core/_shared/money";
import { IanaTimeZone, Locale, ServiceMarket } from "../../src/core/_shared/context";
import { Category } from "../../src/core/categories/model";
import { Budget } from "../../src/core/budgets/model";
import { calculateBudgetStatus } from "../../src/core/budgets/rules";
import {
  dashboardBudgetSpent,
  projectDashboardMetric,
  resolveDashboardPeriod,
} from "../../src/core/dashboard/calculation";
import {
  type DashboardDocument,
  type LayoutNode,
  type Widget,
} from "../../src/core/dashboard/model";
import { Transaction } from "../../src/core/transactions/model";
import {
  groupDashboardChart,
  selectDashboardFacts as selected,
} from "../../src/core/dashboard/projection";
import { type DashboardView, type DashboardWidgetView } from "../../src/shell/dashboard/operations";
import { budgetFromRow } from "../budgets/budget-row";
import { effectiveTransactionRelation } from "../transactions/effective-transaction";

class DashboardUnavailable extends Data.TaggedError("DashboardUnavailable") {}
const maximumBudgets = 128;
const maximumProjectionFacts = 8192;
const TransactionRow = Schema.Struct({
  id: Transaction.fields.id,
  amount: Schema.String,
  currency: Money.fields.currency,
  direction: Transaction.fields.direction,
  counterparty: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  category_id: Category.fields.id,
  label: Category.fields.label,
  occurred_at: Schema.String,
  created_at: Schema.String,
  revision: Transaction.fields.revision,
});
const UserContextRow = Schema.Struct({
  service_market: ServiceMarket,
  locale: Locale,
  time_zone: IanaTimeZone,
});
const BudgetRow = Schema.Struct({
  id: Budget.fields.id,
  category_id: Budget.fields.categoryId,
  currency: Money.fields.currency,
  cap: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;
type Loaded = Readonly<{
  movements: ReadonlyArray<DashboardTransactionFact>;
  budgets: ReadonlyArray<Budget>;
  categories: ReadonlyMap<string, Category>;
  context: typeof UserContextRow.Type;
}>;

const decodeTransactionFact = (raw: unknown): Option.Option<DashboardTransactionFact> =>
  Option.flatMap(Schema.decodeUnknownOption(TransactionRow)(raw), (row) =>
    Option.map(
      Schema.decodeOption(Schema.toCodecJson(Transaction))({
        id: row.id,
        money: { amount: row.amount, currency: row.currency },
        direction: row.direction,
        categoryId: row.category_id,
        ...(row.counterparty === null ? {} : { counterparty: row.counterparty }),
        ...(row.notes === null ? {} : { notes: row.notes }),
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
        revision: row.revision,
      }),
      (transaction) => ({ transaction, category: { id: row.category_id, label: row.label } })
    )
  );

const decodeFacts = (
  input: Readonly<{
    userResult: D1Result<unknown>;
    categories: D1Result<unknown>;
    budgets: D1Result<unknown>;
    movements: D1Result<unknown>;
  }>
): Option.Option<Loaded> => {
  const context = Schema.decodeUnknownOption(UserContextRow)(input.userResult.results[0]);
  if (
    Option.isNone(context) ||
    input.budgets.results.length > maximumBudgets ||
    input.movements.results.length > maximumProjectionFacts
  ) {
    return Option.none();
  }
  const categories = Option.all(
    input.categories.results.map((raw) => Schema.decodeUnknownOption(Category)(raw))
  );
  const budgets = Option.all(
    input.budgets.results.map((raw) =>
      Option.flatMap(Schema.decodeUnknownOption(BudgetRow)(raw), () => budgetFromRow(raw))
    )
  );
  const movements = Option.all(input.movements.results.map(decodeTransactionFact));
  return Option.map(Option.all({ categories, budgets, movements }), (facts) => ({
    ...facts,
    categories: new Map(facts.categories.map((category) => [category.id, category])),
    context: context.value,
  }));
};

/** Fail closed when current facts exceed the per-request work budget; never truncate Currency totals. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const loadDashboardFacts = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<Loaded>> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const [userResult, categories, budgets, movements] = yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?").bind(userId),
        db.prepare("SELECT id, label FROM categories ORDER BY display_order LIMIT 32"),
        db
          .prepare(
            "SELECT id, category_id, currency, cap, created_at, updated_at FROM budgets WHERE user_id = ? LIMIT 129"
          )
          .bind(userId),
        db
          .prepare(`WITH ${relation.sql} SELECT movement.id, movement.amount, movement.currency,
        movement.direction, movement.counterparty, movement.notes, movement.category_id, category.label,
        movement.occurred_at, movement.created_at, movement.revision
        FROM effective_transaction movement JOIN categories category ON category.id = movement.category_id
        WHERE movement.user_id = ? ORDER BY movement.occurred_at DESC, movement.created_at DESC, movement.id DESC
        LIMIT ${maximumProjectionFacts + 1}`)
          .bind(...relation.bindings, userId),
      ])
    );
    if (
      userResult === undefined ||
      categories === undefined ||
      budgets === undefined ||
      movements === undefined
    ) {
      return Option.none();
    }
    return decodeFacts({ userResult, categories, budgets, movements });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

type ChartWidget = Extract<Widget, { type: "spending-chart" }>;

const renderChart = (
  widget: ChartWidget,
  facts: Loaded,
  now: DateTime.Utc
): DashboardWidgetView => {
  const period = resolveDashboardPeriod({
    now,
    period: widget.period,
    timeZone: facts.context.time_zone,
  });
  return {
    widget,
    result: {
      appliedPeriod: period,
      buckets: groupDashboardChart(
        selected(facts.movements, widget, Option.some(period)).map(({ transaction, category }) => ({
          category,
          occurredAt: transaction.occurredAt.epochMilliseconds,
          direction: transaction.direction,
          money: transaction.money,
        })),
        { groupBy: widget.groupBy, timeZone: facts.context.time_zone }
      ),
    },
  };
};

const renderList = (
  widget: Extract<Widget, { type: "transaction-list" }>,
  facts: Loaded
): DashboardWidgetView => {
  const rows = selected(facts.movements, widget, Option.none()).slice(0, widget.limit);
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
};

const renderMetric = (
  widget: Extract<Widget, { type: "custom-metric" }>,
  facts: Loaded,
  now: DateTime.Utc
): DashboardWidgetView => {
  const period = resolveDashboardPeriod({
    now,
    period: widget.period,
    timeZone: facts.context.time_zone,
  });
  return {
    widget,
    result: {
      appliedPeriod: period,
      moneyGroups: projectDashboardMetric(
        selected(facts.movements, widget, Option.some(period)).map(({ transaction }) => ({
          direction: transaction.direction,
          money: transaction.money,
        })),
        widget.aggregation
      ),
    },
  };
};

const budgetSpent = (
  widget: Extract<Widget, { type: "budget-bar" }>,
  facts: Loaded,
  period: ReturnType<typeof resolveDashboardPeriod>
): Money =>
  dashboardBudgetSpent(
    selected(facts.movements, widget, Option.some(period)).map(({ transaction }) => ({
      direction: transaction.direction,
      money: transaction.money,
    })),
    widget.currency
  );

const renderBudget = (
  widget: Extract<Widget, { type: "budget-bar" }>,
  facts: Loaded,
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
    const spent = budgetSpent(widget, facts, period);
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
  facts: Loaded,
  now: DateTime.Utc
): Effect.Effect<DashboardWidgetView, DashboardUnavailable> =>
  Effect.gen(function* () {
    switch (widget.type) {
      case "transaction-list":
        return renderList(widget, facts);
      case "spending-chart":
        return renderChart(widget, facts, now);
      case "custom-metric":
        return renderMetric(widget, facts, now);
      case "budget-bar":
        return yield* renderBudget(widget, facts, now);
    }
  });

/** Rebuild the recursive view from canonical layout, with one typed result at each leaf. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const renderDashboardView = (
  document: DashboardDocument,
  facts: Loaded,
  now: DateTime.Utc
): Effect.Effect<DashboardView, DashboardUnavailable> => {
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
