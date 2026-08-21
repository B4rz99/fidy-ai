import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { nextLifecycleOperations } from "./errors";
import { selectPendingInsights } from "./repo";

export type ListPendingInsightsInput = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
}>;

/**
 * Reads the caller's pending Insights. The suggested operations describe the first Insight only:
 * the lifecycle is advanced one Insight at a time, so offering more would suggest work the caller
 * cannot yet perform.
 */
export const listPendingInsights = Effect.fn("listPendingInsights")(function* ({
  userId,
  caller,
}: ListPendingInsightsInput) {
  const data = yield* selectPendingInsights(userId);
  const first = data[0];
  return {
    data,
    next:
      first === undefined
        ? []
        : nextLifecycleOperations({
            insightEventId: first.id,
            current: first.lifecycleState,
            caller,
          }),
  };
});
