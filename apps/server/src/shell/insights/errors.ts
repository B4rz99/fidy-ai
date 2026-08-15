import { Option } from "effect";
import { type InsightFailure } from "~/core/insights/errors";
import { type InsightEventId, type InsightLifecycleState } from "~/core/insights/model";
import { allowedInsightTransitions } from "~/core/insights/rules";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { type SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  type SuggestedOperationCandidate,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";

/** Public failures for an absent owned occurrence or an invalid lifecycle movement. */
export type InsightApiFailure = NotFound | ValidationFailed;

const suggestionFor = (
  insightEventId: InsightEventId,
  target: InsightLifecycleState
): Option.Option<SuggestedOperationCandidate> => {
  const args = Option.some({ params: { id: insightEventId } });
  switch (target) {
    case "pending":
      return Option.none();
    case "delivered":
      return Option.some(
        suggestOperation({
          tool: "insights.markInsightDelivered",
          args,
          hint: "Record delivery only after an external provider accepts the send.",
        })
      );
    case "read":
      return Option.some(
        suggestOperation({
          tool: "insights.markInsightRead",
          args,
          hint: "Mark this insight read after the user or their agent consumes it.",
        })
      );
    case "dismissed":
      return Option.some(
        suggestOperation({
          tool: "insights.dismissInsight",
          args,
          hint: "Dismiss this insight when it should receive no further attention.",
        })
      );
  }
};

const lifecycleSuggestions = (
  insightEventId: InsightEventId,
  allowedTargets: ReadonlyArray<InsightLifecycleState>,
  caller: SuggestedOperationCaller
): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: allowedTargets.flatMap((target) =>
      Option.toArray(suggestionFor(insightEventId, target))
    ),
    caller,
  });

/**
 * Makes a lifecycle failure actionable without leaking ownership. The event id
 * comes from operation context because pure transition failures carry no entity;
 * caller facts control whether recovery may advertise each canonical operation.
 */
export const toApiFailure = ({
  failure,
  insightEventId,
  caller,
}: {
  readonly failure: InsightFailure;
  readonly insightEventId: InsightEventId;
  readonly caller: SuggestedOperationCaller;
}): InsightApiFailure => {
  switch (failure._tag) {
    case "InsightNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message:
            `No insight ${failure.insightEventId} is in your stream. ` +
            "List pending insights to see occurrences you can act on.",
        },
        next: checkpointSuggestedOperations({
          candidates: [
            suggestOperation({
              tool: "insights.listPendingInsights",
              hint: "List pending insights to find an occurrence you can act on.",
            }),
          ],
          caller,
        }),
      });

    case "InvalidInsightTransition":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            `Insight ${insightEventId} is ${failure.current} and cannot move to ` +
            `${failure.target}. ` +
            (failure.allowedTargets.length === 0
              ? "No further lifecycle operation is valid for it."
              : "Choose one of the suggested valid lifecycle operations."),
          fields: [],
        },
        next: lifecycleSuggestions(insightEventId, failure.allowedTargets, caller),
      });
  }
};

/** Returns state-valid lifecycle calls after applying the caller-authorization checkpoint. */
export const nextLifecycleOperations = ({
  insightEventId,
  current,
  caller,
}: {
  readonly insightEventId: InsightEventId;
  readonly current: InsightLifecycleState;
  readonly caller: SuggestedOperationCaller;
}): ReadonlyArray<SuggestedOperation> =>
  lifecycleSuggestions(insightEventId, allowedInsightTransitions(current), caller);
