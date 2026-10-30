import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  Budget,
  BudgetId,
  BudgetStatusQueryParameters,
  BudgetWorkspace,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "~/core/budgets/contract";

import {
  NotFound,
  OperationResponse,
  ValidationFailed,
  createdStatus,
} from "~/shell/public-http/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";

const read = operationPolicy({
  access: userOwnedAgentScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const additiveWrite = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const destructiveWrite = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

export const BudgetsGroup = HttpApiGroup.make("budgets")
  .add(
    HttpApiEndpoint.post("createBudget", "/budgets", {
      payload: CreateBudgetInput,
      success: OperationResponse(Budget).pipe(HttpApiSchema.status(createdStatus)),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Create one positive Money cap for a stable Category and Currency. Supply month (YYYY-MM) to save a monthly plan and groupName to organize the view. Other saved months retain their amounts; new plans inherit previous amounts without rollover."
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
        "Replace a Budget's Category and positive cap. Supply month (YYYY-MM) to edit only that saved month and groupName to organize it. Supply groupCategoryIds with groupName to rename the caller-owned category collection across months. Currency is immutable; reached monthly alert marks remain latched."
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
      success: OperationResponse(BudgetWorkspace),
    })
      .annotate(
        OpenApi.Description,
        "Answer Budget status for an optional month (YYYY-MM), defaulting to the current month. Uninitialized plans preview previous planned amounts; an explicit month-scoped write freezes the plan. Supply the IANA time zone whose calendar boundaries apply; optional Category and Currency filters combine, and omitted Currency returns separate deterministically ordered results without conversion or aggregation."
      )
      .annotateMerge(read)
  );
