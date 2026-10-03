import { Category, type CategoryId } from "~/core/categories/contract";
import {
  AppliedDashboardPeriod,
  BudgetBarWidget,
  CustomMetricWidget,
  DashboardCatalog,
  DashboardChartBucket,
  DashboardDocument,
  DashboardEdit,
  DashboardQueryContext,
  DashboardTitle,
  type ProjectedRange,
  SpendingChartWidget,
  TransactionListWidget,
  makeLayoutNodeSchema,
} from "~/core/dashboard/contract";
import { type Budget, BudgetProgress } from "~/core/budgets/contract";
import type { UserContext } from "~/core/identity/contract";

import { Data, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Currency, MoneyGroups } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";

import { Transaction } from "~/core/transactions/contract";
import { NotFound, OperationResponse, ValidationFailed } from "~/shell/public-http/contract";
import { operationPolicy, patScoped } from "~/shell/canonical-policy/contract";

const SpendingChartResult = Schema.Struct({
  appliedPeriod: AppliedDashboardPeriod,
  buckets: Schema.Array(DashboardChartBucket),
}).annotate({ identifier: "SpendingChartResult" });

const AvailableBudgetResultShape = Schema.Struct({
  availability: Schema.Literal("available"),
  appliedPeriod: AppliedDashboardPeriod,
  category: Category,
  currency: Currency,
  ...BudgetProgress.fields,
});

const validBudgetCurrencies = Schema.makeFilter<typeof AvailableBudgetResultShape.Type>((data) => {
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
  if (!Schema.is(BudgetProgress)(data)) {
    return { path: ["status", "type"], issue: "Expected exact Budget progress" };
  }
  return undefined;
});

const AvailableBudgetResult = AvailableBudgetResultShape.check(validBudgetCurrencies);

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

/** Canonical call shape for first-use Dashboard persistence. */
export const GetDashboardCanonicalInput = Schema.Struct({});
/** Canonical call shape for first-use Dashboard view persistence. */
export const GetDashboardViewCanonicalInput = Schema.Struct({});
/** Canonical call shape for a Dashboard edit, shared by individual and batch execution. */
export const ApplyDashboardEditCanonicalInput = Schema.Struct({ payload: DashboardEdit });

/** Canonical contracts for the caller's one persistent DashboardDocument and ephemeral view. */
export const DashboardGroup = HttpApiGroup.make("dashboard")
  .add(
    HttpApiEndpoint.get("getDashboard", "/dashboard", {
      success: OperationResponse(DashboardDocument),
    })
      .annotate(
        OpenApi.Description,
        "Get the caller's complete DashboardDocument. Reach for this before editing; first use " +
          "creates and retains one valid four-Widget Dashboard, and later calls return the same document."
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

/** A complete validated Dashboard projection cannot be produced from the supplied facts. */
export class DashboardUnavailable extends Data.TaggedError("DashboardUnavailable") {}

/** Decoded User-owned facts supplied by the storage adapter for one Dashboard projection. */
export type DashboardFacts = Readonly<{
  groups: ReadonlyMap<string, ReadonlyArray<ProjectedRange>>;
  lists: ReadonlyMap<
    string,
    ReadonlyArray<Readonly<{ transaction: Transaction; category: Category }>>
  >;
  budgets: ReadonlyArray<Budget>;
  categories: ReadonlyMap<string, Category>;
  context: UserContext;
}>;

/** A candidate dashboard references a Category unavailable to the authenticated User. */
export class DashboardCategoryNotFound extends Data.TaggedError("DashboardCategoryNotFound")<{
  readonly categoryId: CategoryId;
  readonly path: string;
}> {}

/** Declared canonical failures returned by dashboard operations. */
export type DashboardApiFailure = NotFound | ValidationFailed;
