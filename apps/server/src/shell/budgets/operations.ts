import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  Budget,
  BudgetStatusQueryValues,
  BudgetStatusReport,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "~/core/budgets/model";
import { BudgetId } from "~/core/budgets/reference";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { createdStatus } from "~/shell/_shared/http-status";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const read = operationPolicy({
  access: patScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const additiveWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const destructiveWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

const BudgetStatusQueryParameters = Schema.Struct({
  categoryId: Schema.optionalKey(BudgetStatusQueryValues.fields.categoryId),
  currency: Schema.optionalKey(BudgetStatusQueryValues.fields.currency),
  timeZone: BudgetStatusQueryValues.fields.timeZone,
});

/** User-scoped monthly Budget management and one-call current-month status lookup. */
export const BudgetsGroup = HttpApiGroup.make("budgets")
  .add(
    HttpApiEndpoint.post("createBudget", "/budgets", {
      payload: CreateBudgetInput,
      success: OperationResponse(Budget).pipe(HttpApiSchema.status(createdStatus)),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Create one positive monthly Money cap for a stable Category and Currency. Only one Budget may exist for the same Category and Currency."
      )
      .annotateMerge(additiveWrite)
  )
  .add(
    HttpApiEndpoint.get("listBudgets", "/budgets", {
      success: OperationResponse(Schema.Array(Budget)),
    })
      .annotate(
        OpenApi.Description,
        "List all of the caller's Budgets in deterministic Currency and Category order."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("getBudget", "/budgets/:id", {
      params: Schema.Struct({ id: BudgetId }),
      success: OperationResponse(Budget),
      error: NotFound,
    })
      .annotate(OpenApi.Description, "Fetch one caller-owned Budget by stable identity.")
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.put("updateBudget", "/budgets/:id", {
      params: Schema.Struct({ id: BudgetId }),
      payload: UpdateBudgetInput,
      success: OperationResponse(Budget),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Replace a Budget's Category and positive cap. Its Currency is immutable; changing Category resets current-month alert marks."
      )
      .annotateMerge(destructiveWrite)
  )
  .add(
    HttpApiEndpoint.delete("deleteBudget", "/budgets/:id", {
      params: Schema.Struct({ id: BudgetId }),
      success: OperationResponse(BudgetId),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Permanently delete one Budget and its operational monthly alert marks."
      )
      .annotateMerge(destructiveWrite)
  )
  .add(
    HttpApiEndpoint.get("getBudgetStatus", "/budget-status", {
      query: BudgetStatusQueryParameters,
      success: OperationResponse(BudgetStatusReport),
    })
      .annotate(
        OpenApi.Description,
        "Answer current monthly Budget status in one call. Supply the IANA time zone whose calendar boundaries apply; optional Category and Currency filters combine, and omitted Currency returns separate deterministically ordered results without conversion or aggregation."
      )
      .annotateMerge(read)
  );
