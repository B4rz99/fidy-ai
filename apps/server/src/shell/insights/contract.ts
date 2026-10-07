import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  DeliveryEvidenceInput,
  InsightDeliveryAttempt,
  InsightEvent,
  InsightEventId,
  RecurringDigestReport,
  RecurringDigestReportParams,
  ReminderSchedule,
  ReminderScheduleEdit,
} from "~/core/insights/contract";
import { NotFound, OperationResponse, ValidationFailed } from "~/shell/public-http/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";

/** Canonical operations over the caller's shared InsightEvent stream. */
const InsightParams = Schema.Struct({ id: InsightEventId });
const InsightOperationFailures = [NotFound, ValidationFailed] as const;

/** Canonical result pairing one delivered InsightEvent with its immutable provider evidence. */
export const DeliveredInsight = Schema.Struct({
  insight: InsightEvent,
  deliveryAttempt: InsightDeliveryAttempt,
});

/**
 * Canonical contract for one caller's shared InsightEvent stream. Reads require
 * `read`; lifecycle movement requires `write`; ownership comes only from the
 * authenticated caller, never from request payloads or opaque event ids.
 */
export const InsightsGroup = HttpApiGroup.make("insights")
  .add(
    HttpApiEndpoint.get("getRecurringDigestReport", "/insights/recurring/:id", {
      params: RecurringDigestReportParams,
      success: OperationResponse(RecurringDigestReport),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Read your complete immutable itemized recurring-charge detection report. These historical patterns do not imply active commitments. All items preserve captured Money and Currency. Expired delivery leaves the report available."
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
    HttpApiEndpoint.get("getReminderSchedule", "/insights/reminder", {
      success: OperationResponse(Schema.NullOr(ReminderSchedule)),
    })
      .annotate(
        OpenApi.Description,
        "Read your manual-entry reminder instructions. Null means you have not opted in. This operation never grants delivery Consent."
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
    HttpApiEndpoint.post("updateReminderSchedule", "/insights/reminder", {
      payload: ReminderScheduleEdit,
      success: OperationResponse(ReminderSchedule),
      error: InsightOperationFailures,
    })
      .annotate(
        OpenApi.Description,
        "Revise your existing reminder cadence, local time and IANA zone with the version you read. A stale version is refused: read again before retrying. This does not activate reminders, change delivery Consent, or rewrite historical occurrences."
      )
      .annotateMerge(
        operationPolicy({
          access: userOwnedAgentScoped("write"),
          requiredTier: "free",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  )
  .add(
    HttpApiEndpoint.get("listPendingInsights", "/insights/pending", {
      query: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
      success: OperationResponse(Schema.Array(InsightEvent)),
    })
      .annotate(
        OpenApi.Description,
        "List the caller's pending InsightEvents, oldest scheduled occurrence first. Reach for " +
          "this when you want proactive financial facts fidy has generated but the user has not " +
          "yet consumed or dismissed. An empty stream is a successful answer. Results are " +
          "bounded to 64 per page; follow the Link rel=next response header with its cursor " +
          "to continue without skipping pending occurrences."
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
    HttpApiEndpoint.post("markInsightDelivered", "/insights/:id/delivered", {
      params: InsightParams,
      payload: DeliveryEvidenceInput,
      success: OperationResponse(DeliveredInsight),
      error: InsightOperationFailures,
    })
      .annotate(
        OpenApi.Description,
        "Record one actual external send attempt for the caller's pending InsightEvent and mark " +
          "it delivered. Use this only after a provider accepted the send: supply its UTC send " +
          "instant, channel, provider, and message id. This operation sends nothing itself."
      )
      .annotateMerge(
        operationPolicy({
          access: userOwnedAgentScoped("write"),
          requiredTier: "free",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  )
  .add(
    HttpApiEndpoint.post("markInsightRead", "/insights/:id/read", {
      params: InsightParams,
      success: OperationResponse(InsightEvent),
      error: InsightOperationFailures,
    })
      .annotate(
        OpenApi.Description,
        "Mark one pending or delivered InsightEvent of the caller as read. Use this after the " +
          "User or their agent has consumed the generated occurrence; delivery evidence is not " +
          "required when an agent pulled it directly."
      )
      .annotateMerge(
        operationPolicy({
          access: userOwnedAgentScoped("write"),
          requiredTier: "free",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  )
  .add(
    HttpApiEndpoint.post("dismissInsight", "/insights/:id/dismissed", {
      params: InsightParams,
      success: OperationResponse(InsightEvent),
      error: InsightOperationFailures,
    })
      .annotate(
        OpenApi.Description,
        "Dismiss one pending, delivered, or read InsightEvent of the caller. Use this when the " +
          "occurrence should receive no further attention; dismissed events cannot move again."
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

/** Public failures for an absent owned occurrence or an invalid lifecycle movement. */
export type InsightApiFailure = NotFound | ValidationFailed;
