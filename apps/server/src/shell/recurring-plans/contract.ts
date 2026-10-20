import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  RecurringCommand,
  RecurringDocument,
  RecurringFilters,
  RecurringMatchFact,
  RecurringMonth,
  RecurringOccurrence,
  RecurringSummary,
} from "~/core/recurring-plans/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";
import { OperationResponse, ValidationFailed } from "~/shell/public-http/contract";

export const RecurringWorkspaceQuery = Schema.Struct({
  month: RecurringMonth,
  previousMonth: Schema.optionalKey(RecurringMonth),
  ...RecurringFilters.fields,
});
export const RecurringWorkspace = Schema.Struct({
  document: RecurringDocument,
  month: RecurringMonth,
  today: Schema.String,
  occurrences: Schema.Array(RecurringOccurrence),
  previous: Schema.Array(RecurringOccurrence),
  previousMonth: Schema.optionalKey(RecurringMonth),
  summary: Schema.Array(RecurringSummary),
  invalidFulfillmentIds: Schema.Array(Schema.String),
  matches: Schema.Array(Schema.Struct({ item: RecurringOccurrence, fact: RecurringMatchFact })),
  matchesComplete: Schema.Boolean,
});
export const ApplyRecurringCanonicalInput = Schema.Struct({ payload: RecurringCommand });
export const RecurringPlansGroup = HttpApiGroup.make("recurringPlans")
  .add(
    HttpApiEndpoint.get("getRecurringWorkspace", "/recurring-plans", {
      query: RecurringWorkspaceQuery,
      success: OperationResponse(RecurringWorkspace),
      error: ValidationFailed,
    })
      .annotate(
        OpenApi.Description,
        "Read a recurring month and Currency-separated totals. Get plan IDs from data.document.plans and expectedRevision from data.document.revision before editing; never ask the User. Follow previousMonth for older unresolved items."
      )
      .annotateMerge(
        operationPolicy({
          access: userOwnedAgentScoped("read"),
          requiredTier: "free",
          agentConfirmation: "not-required",
          kind: "query",
        })
      )
  )
  .add(
    HttpApiEndpoint.post("applyRecurringEdit", "/recurring-plans/edits", {
      payload: RecurringCommand,
      success: OperationResponse(RecurringDocument),
      error: ValidationFailed,
    })
      .annotate(
        OpenApi.Description,
        "Create/edit plans, lifecycle, occurrences, tracking, Transaction associations or suggestions. Read recurringPlans.getRecurringWorkspace for the revision and plan ID, then propose the edit; the host obtains exact approval. Reread unknown outcomes; never replay blindly. Tracking creates no Transactions and never cancels external services."
      )
      .annotateMerge(
        operationPolicy({
          access: userOwnedAgentScoped("write"),
          requiredTier: "free",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  );
