import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type UserId } from "~/core/identity/reference";
import { InsightNotFound } from "~/core/insights/errors";
import {
  type DeliveryEvidenceInput,
  type InsightDeliveryAttempt,
  type InsightEvent,
  type InsightEventId,
  type InsightLifecycleState,
} from "~/core/insights/model";
import { transitionInsight } from "~/core/insights/rules";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { type SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  makeFreeSuggestedOperationCaller,
} from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { type InsightApiFailure, nextLifecycleOperations, toApiFailure } from "./errors";
import {
  appendDeliveryAttempt,
  listPendingInsights,
  updateInsightState,
  withInsightLock,
} from "./repo";

type InsightMovement = {
  readonly userId: UserId;
  readonly insightEventId: InsightEventId;
  readonly target: InsightLifecycleState;
  readonly caller: SuggestedOperationCaller;
};

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

const moveInsight = ({
  userId,
  insightEventId,
  target,
  caller,
}: InsightMovement): Effect.Effect<InsightEvent, InsightApiFailure, SqlClient.SqlClient> =>
  withInsightLock(userId, insightEventId, (current) =>
    Effect.gen(function* () {
      const lifecycleState = yield* transitionInsight({
        current: current.lifecycleState,
        target,
      });
      return yield* updateInsightState(userId, { id: insightEventId, lifecycleState });
    })
  ).pipe(
    Effect.flatMap(Effect.fromOption(() => new InsightNotFound({ insightEventId }))),
    Effect.mapError((failure) => toApiFailure({ failure, insightEventId, caller }))
  );

const deliverInsight = ({
  userId,
  insightEventId,
  input,
  caller,
}: {
  readonly userId: UserId;
  readonly insightEventId: InsightEventId;
  readonly input: DeliveryEvidenceInput;
  readonly caller: SuggestedOperationCaller;
}): Effect.Effect<
  { insight: InsightEvent; deliveryAttempt: InsightDeliveryAttempt },
  InsightApiFailure,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const insight = yield* moveInsight({
            userId,
            insightEventId,
            target: "delivered",
            caller,
          });
          const deliveryAttempt = yield* appendDeliveryAttempt(userId, insightEventId, input);
          return { insight, deliveryAttempt };
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die));
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
        const result = yield* deliverInsight({
          userId,
          insightEventId: params.id,
          input: payload,
          caller,
        });

        return { data: result, next: insightLifecycleOperations(result.insight, caller) };
      })
    )
    .handle("markInsightRead", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller;
        const insight = yield* moveInsight({
          userId,
          insightEventId: params.id,
          target: "read",
          caller,
        });

        return { data: insight, next: insightLifecycleOperations(insight, caller) };
      })
    )
    .handle("dismissInsight", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller;
        const insight = yield* moveInsight({
          userId,
          insightEventId: params.id,
          target: "dismissed",
          caller,
        });

        return { data: insight, next: [] };
      })
    )
);
