import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Currency, Money, MoneyGroups, type ReadonlyMoney } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  OverBudget,
  ReachedBudget,
  UnderBudget,
  hasExactBudgetProgress,
} from "~/core/budgets/model";
import { Category } from "~/core/categories/model";
import {
  AppliedDashboardPeriod,
  BudgetBarWidget,
  CustomMetricWidget,
  DashboardCatalog,
  DashboardDocument,
  DashboardEdit,
  DashboardQueryContext,
  DashboardTitle,
  SpendingChartWidget,
  TransactionListWidget,
  makeLayoutNodeSchema,
} from "~/core/dashboard/model";
import { Transaction } from "~/core/transactions/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const LocalCalendarDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u)
);
const LocalCalendarMonth = Schema.String.check(Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])$/u));
const SpendingBucketKey = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("category"), category: Category }),
  Schema.Struct({ kind: Schema.Literal("day"), date: LocalCalendarDate }),
  Schema.Struct({ kind: Schema.Literal("month"), month: LocalCalendarMonth }),
]);

const SpendingChartResult = Schema.Struct({
  appliedPeriod: AppliedDashboardPeriod,
  buckets: Schema.Array(
    Schema.Struct({
      key: SpendingBucketKey,
      moneyGroups: MoneyGroups,
    })
  ),
}).annotate({ identifier: "SpendingChartResult" });

const BudgetStatus = Schema.Union([
  UnderBudget.mapFields(Struct.pick(["type", "remaining"])),
  ReachedBudget.mapFields(Struct.pick(["type"])),
  OverBudget.mapFields(Struct.pick(["type", "overBy"])),
]);

const validBudgetCurrencies = Schema.makeFilter<
  Readonly<{
    readonly currency: Currency;
    readonly cap: ReadonlyMoney;
    readonly spent: ReadonlyMoney;
    readonly status:
      | Readonly<{ readonly type: "under"; readonly remaining: ReadonlyMoney }>
      | Readonly<{ readonly type: "reached" }>
      | Readonly<{ readonly type: "over"; readonly overBy: ReadonlyMoney }>;
  }>
>((data) => {
  if (data.cap.currency !== data.currency) {
    return { path: ["cap", "currency"], issue: "Expected the Budget Currency" };
  }
  if (data.spent.currency !== data.currency) {
    return { path: ["spent", "currency"], issue: "Expected the Budget Currency" };
  }
  if (data.status.type === "under" && data.status.remaining.currency !== data.currency) {
    return { path: ["status", "remaining", "currency"], issue: "Expected the Budget Currency" };
  }
  if (data.status.type === "over" && data.status.overBy.currency !== data.currency) {
    return { path: ["status", "overBy", "currency"], issue: "Expected the Budget Currency" };
  }
  if (!hasExactBudgetProgress(data)) {
    return { path: ["status", "type"], issue: "Expected exact Budget progress" };
  }
  return undefined;
});

const AvailableBudgetResult = Schema.Struct({
  availability: Schema.Literal("available"),
  appliedPeriod: AppliedDashboardPeriod,
  category: Category,
  currency: Currency,
  cap: Money,
  spent: Money,
  status: BudgetStatus,
}).check(validBudgetCurrencies);

const MissingBudgetResult = Schema.Struct({
  availability: Schema.Literal("missing-budget"),
  appliedPeriod: AppliedDashboardPeriod,
  category: Category,
  currency: Currency,
});

const BudgetBarResult = Schema.Union([AvailableBudgetResult, MissingBudgetResult]).annotate({
  identifier: "BudgetBarResult",
});

const DashboardTransaction = Schema.Struct({
  id: Transaction.fields.id,
  money: Transaction.fields.money,
  counterparty: Transaction.fields.counterparty,
  direction: Transaction.fields.direction,
  category: Category,
  occurredAt: Transaction.fields.occurredAt,
}).annotate({ identifier: "DashboardTransaction" });

const TransactionListResult = Schema.Struct({
  transactions: Schema.Array(DashboardTransaction),
}).annotate({ identifier: "TransactionListResult" });

const CustomMetricResult = Schema.Struct({
  appliedPeriod: AppliedDashboardPeriod,
  moneyGroups: MoneyGroups,
}).annotate({ identifier: "CustomMetricResult" });

/** One closed Widget variant paired with its only legal ephemeral result. */
export const DashboardWidgetView = Schema.Union([
  Schema.Struct({ widget: SpendingChartWidget, result: SpendingChartResult }),
  Schema.Struct({ widget: BudgetBarWidget, result: BudgetBarResult }),
  Schema.Struct({ widget: TransactionListWidget, result: TransactionListResult }),
  Schema.Struct({ widget: CustomMetricWidget, result: CustomMetricResult }),
]).annotate({ identifier: "DashboardWidgetView" });
export type DashboardWidgetView = typeof DashboardWidgetView.Type;

const DashboardViewLayout = makeLayoutNodeSchema({
  leaf: () => DashboardWidgetView,
  identifier: "DashboardViewLayout",
});

const DashboardViewContext = Schema.Struct({
  ...DashboardQueryContext.fields,
  calculatedAt: UtcTimestamp,
}).annotate({ identifier: "DashboardViewContext" });

/** One complete ephemeral Dashboard projection with a result colocated at every recursive leaf. */
export const DashboardView = Schema.Struct({
  title: DashboardTitle,
  context: DashboardViewContext,
  layout: DashboardViewLayout,
}).annotate({ identifier: "DashboardView" });
export type DashboardView = typeof DashboardView.Type;

const DashboardEditFailures = [NotFound, ValidationFailed] as const;

/** Canonical contracts for the caller's one persistent DashboardDocument and ephemeral view. */
export const DashboardGroup = HttpApiGroup.make("dashboard")
  .add(
    HttpApiEndpoint.get("getDashboard", "/dashboard", {
      success: OperationResponse(DashboardDocument),
    })
      .annotate(
        OpenApi.Description,
        "Get the caller's complete DashboardDocument. Reach for this before editing; first use " +
          "creates and retains one valid spending widget, and later calls return the same document."
      )
      .annotateMerge(
        operationPolicy({
          access: patScoped("read"),
          requiredTier: "free",
          agentConfirmation: "not-required",
          kind: "mutation",
        })
      )
  )
  .add(
    HttpApiEndpoint.get("getDashboardView", "/dashboard/view", {
      success: OperationResponse(DashboardView),
    })
      .annotate(
        OpenApi.Description,
        "Render one complete enriched projection of the caller's decoded DashboardDocument using " +
          "current User context and purpose-specific exact facts. First use creates the same document."
      )
      .annotateMerge(
        operationPolicy({
          access: patScoped("read"),
          requiredTier: "free",
          agentConfirmation: "not-required",
          kind: "mutation",
        })
      )
  )
  .add(
    HttpApiEndpoint.get("listDashboardCatalog", "/dashboard/catalog", {
      success: OperationResponse(DashboardCatalog),
    })
      .annotate(
        OpenApi.Description,
        "List the four valid direct-launch widget presets shared by the web UI and agents. " +
          "Choose a template, assign a fresh UUID as its WidgetId, then send it through " +
          "dashboard.applyDashboardEdit with add-widget."
      )
      .annotateMerge(
        operationPolicy({
          access: patScoped("read"),
          requiredTier: "free",
          agentConfirmation: "not-required",
          kind: "query",
        })
      )
  )
  .add(
    HttpApiEndpoint.post("applyDashboardEdit", "/dashboard/edits", {
      payload: DashboardEdit,
      success: OperationResponse(DashboardDocument),
      error: DashboardEditFailures,
    })
      .annotate(
        OpenApi.Description,
        "Apply one DashboardEdit to the caller's latest locked document. Invalid edits and invalid " +
          "resulting documents leave the stored Dashboard unchanged."
      )
      .annotateMerge(
        operationPolicy({
          access: patScoped("dashboard"),
          requiredTier: "free",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  );
