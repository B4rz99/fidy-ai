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
        "Read a complete filtered recurring month, currency-separated totals and one previous-month page without changing plans or confirming payments. Follow previousMonth to inspect older unresolved items. Historical detected suggestions remain in recurring.listRecurringSeries."
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
        "Explicitly create, edit, pause, resume or stop a recurring plan; skip an occurrence; record/reverse a tracking mark or associate an effective Transaction; dismiss, restore or link a detected suggestion. Supply the observed document revision and stable UUIDs. Unknown outcomes require a reread, never blind replay. Manual marks create no Transactions; stopping tracking never cancels external services. Propose a clearly requested edit directly; the host obtains exact User confirmation before execution. Do not ask for a separate informal confirmation."
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
