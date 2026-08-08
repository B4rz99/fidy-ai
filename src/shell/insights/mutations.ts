import { Effect, type Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { type UserId } from "~/core/identity/reference";
import { InsightNotFound } from "~/core/insights/errors";
import {
  type DeliveryEvidenceInput,
  type InsightEvent,
  type InsightEventId,
  type InsightLifecycleState,
} from "~/core/insights/model";
import { transitionInsight } from "~/core/insights/rules";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { OperationResponse } from "~/shell/_shared/response";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { type InsightApiFailure, nextLifecycleOperations, toApiFailure } from "./errors";
import type { DeliveredInsight } from "./operations";
import {
  appendDeliveryAttemptInScope,
  findInsightForUpdateInScope,
  updateInsightStateInScope,
} from "./repo";

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

/** Identifies the authorized User and caller policy shared by canonical Insight mutations. */
export type InsightMutationContext = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
  insightEventId: InsightEventId;
}>;

const moveInsight = ({
  userId,
  insightEventId,
  target,
  caller,
}: InsightMutationContext & {
  readonly target: InsightLifecycleState;
}): Effect.Effect<InsightEvent, InsightApiFailure, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const current = yield* findInsightForUpdateInScope(userId, insightEventId).pipe(
      Effect.flatMap(Effect.fromOption(() => new InsightNotFound({ insightEventId })))
    );
    const lifecycleState = yield* transitionInsight({
      current: current.lifecycleState,
      target,
    });
    return yield* updateInsightStateInScope(userId, { id: insightEventId, lifecycleState });
  }).pipe(Effect.mapError((failure) => toApiFailure({ failure, insightEventId, caller })));

/** Facts supplied after canonical decoding and caller authorization for delivery evidence. */
export type MarkInsightDeliveredInput = InsightMutationContext &
  Readonly<{
    payload: DeliveryEvidenceInput;
  }>;

/**
 * Records accepted delivery evidence and moves its InsightEvent atomically inside the caller-owned
 * transaction. It performs no external send and leaves commit or rollback to the caller.
 */
export const markInsightDelivered: CanonicalMutationImplementation<
  MarkInsightDeliveredInput,
  MutationResponse<typeof DeliveredInsight>,
  InsightApiFailure
> = Effect.fn("markInsightDelivered")(function* ({
  userId,
  insightEventId,
  payload,
  caller,
}: MarkInsightDeliveredInput) {
  const insight = yield* moveInsight({
    userId,
    insightEventId,
    target: "delivered",
    caller,
  });
  const deliveryAttempt = yield* appendDeliveryAttemptInScope(userId, insightEventId, payload);
  return {
    data: { insight, deliveryAttempt },
    next: nextLifecycleOperations({
      insightEventId,
      current: insight.lifecycleState,
      caller,
    }),
  };
});

/**
 * Marks one owned InsightEvent read inside the caller-owned transaction, preserving state-valid
 * SuggestedOperations while leaving commit or rollback to the caller.
 */
export const markInsightRead: CanonicalMutationImplementation<
  InsightMutationContext,
  MutationResponse<typeof InsightEvent>,
  InsightApiFailure
> = Effect.fn("markInsightRead")(function* (input: InsightMutationContext) {
  const insight = yield* moveInsight({ ...input, target: "read" });
  return {
    data: insight,
    next: nextLifecycleOperations({
      insightEventId: input.insightEventId,
      current: insight.lifecycleState,
      caller: input.caller,
    }),
  };
});

/**
 * Dismisses one owned InsightEvent inside the caller-owned transaction. Dismissal is terminal, so
 * the successful response has no SuggestedOperations; the caller owns commit or rollback.
 */
export const dismissInsight: CanonicalMutationImplementation<
  InsightMutationContext,
  MutationResponse<typeof InsightEvent>,
  InsightApiFailure
> = Effect.fn("dismissInsight")(function* (input: InsightMutationContext) {
  const insight = yield* moveInsight({ ...input, target: "dismissed" });
  return { data: insight, next: [] };
});
