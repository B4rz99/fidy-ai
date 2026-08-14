import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type UserId } from "~/core/identity/reference";
import { type InsightEventId, type InsightLifecycleState } from "~/core/insights/model";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { type SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  makeFreeSuggestedOperationCaller,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { nextLifecycleOperations } from "./errors";
import { dismissInsight, markInsightDelivered, markInsightRead } from "./mutations";
import { listPendingInsights } from "./repo";

const resolveInsightCaller: Effect.Effect<
  { userId: UserId; caller: SuggestedOperationCaller },
  never,
  ResolvedCaller
> = Effect.map(ResolvedCaller, ({ scopes, subjectUserId }) => ({
  userId: subjectUserId,
  caller: makeFreeSuggestedOperationCaller(scopes),
}));

const insightLifecycleOperations = (
  insight: Readonly<{
    readonly id: InsightEventId;
    readonly lifecycleState: InsightLifecycleState;
  }>,
  caller: SuggestedOperationCaller
): ReadonlyArray<SuggestedOperation> =>
  nextLifecycleOperations({
    insightEventId: insight.id,
    current: insight.lifecycleState,
    caller,
  });

/** Resolves ownership before every scoped query or lifecycle transition. */
export const InsightsLive = HttpApiBuilder.group(FidyApi, "insights", (handlers) =>
  handlers
    .handle("listPendingInsights", () =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller;
        const insights = yield* listPendingInsights(userId);
        const first = insights[0];

        return {
          data: insights,
          next: first === undefined ? [] : insightLifecycleOperations(first, caller),
        };
      })
    )
    .handle("markInsightDelivered", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller;
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
        const { userId, caller } = yield* resolveInsightCaller;
        return yield* markInsightRead({ userId, caller, insightEventId: params.id });
      })
    )
    .handle("dismissInsight", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller;
        return yield* dismissInsight({ userId, caller, insightEventId: params.id });
      })
    )
);
