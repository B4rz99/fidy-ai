import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { resolveFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { dismissInsight, markInsightDelivered, markInsightRead } from "./mutations";
import { listPendingInsights } from "./queries";

/** Resolves ownership before every scoped query or lifecycle transition. */
export const InsightsLive = HttpApiBuilder.group(FidyApi, "insights", (handlers) =>
  handlers
    .handle("listPendingInsights", () =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* listPendingInsights({ userId, caller });
      })
    )
    .handle("markInsightDelivered", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* markInsightDelivered({
          userId,
          caller,
          insightEventId: params.id,
          payload,
        });
      })
    )
    .handle("markInsightRead", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* markInsightRead({ userId, caller, insightEventId: params.id });
      })
    )
    .handle("dismissInsight", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* dismissInsight({ userId, caller, insightEventId: params.id });
      })
    )
);
