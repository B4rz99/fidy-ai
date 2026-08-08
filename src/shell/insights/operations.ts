import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  DeliveryEvidenceInput,
  InsightDeliveryAttempt,
  InsightEvent,
  InsightEventId,
} from "~/core/insights/model";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

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
    HttpApiEndpoint.get("listPendingInsights", "/insights/pending", {
      success: OperationResponse(Schema.Array(InsightEvent)),
    })
      .annotate(
        OpenApi.Description,
        "List the caller's pending InsightEvents, oldest scheduled occurrence first. Reach for " +
          "this when you want proactive financial facts fidy has generated but the user has not " +
          "yet consumed or dismissed. An empty stream is a successful answer."
      )
      .annotateMerge(
        operationPolicy({
          requiredScope: "read",
          requiredTier: "free",
          costClass: "cheap",
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
          requiredScope: "write",
          requiredTier: "free",
          costClass: "cheap",
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
          requiredScope: "write",
          requiredTier: "free",
          costClass: "cheap",
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
          requiredScope: "write",
          requiredTier: "free",
          costClass: "cheap",
          agentConfirmation: "required",
          kind: "mutation",
        })
      )
  );
