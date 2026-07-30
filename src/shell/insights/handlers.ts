import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type UserId } from "~/core/_shared/user";
import { InsightNotFound } from "~/core/insights/errors";
import {
  type DeliveryEvidenceInput,
  type InsightEventId,
  type InsightLifecycleState,
} from "~/core/insights/model";
import { transitionInsight } from "~/core/insights/rules";
import { resolveCaller } from "~/shell/_shared/authz";
import { type SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { nextLifecycleOperations, toApiFailure } from "./errors";
import {
  appendDeliveryAttempt,
  lockInsightEvent,
  listPendingInsights,
  updateInsightState,
} from "./repo";

type InsightMovement = {
  readonly userId: UserId;
  readonly insightEventId: InsightEventId;
  readonly target: InsightLifecycleState;
  readonly caller: SuggestedOperationCaller;
};

const suggestedOperationCaller = (
  scopes: SuggestedOperationCaller["scopes"]
): SuggestedOperationCaller => ({ scopes, tier: "free" });

const moveInsight = ({ userId, insightEventId, target, caller }: InsightMovement) =>
  Effect.gen(function* () {
    const found = yield* lockInsightEvent(userId, insightEventId);
    const current = yield* found.pipe(
      Effect.fromOption(() => new InsightNotFound({ insightEventId }))
    );
    const lifecycleState = yield* transitionInsight({
      current: current.lifecycleState,
      target,
    });

    return yield* updateInsightState(userId, { id: insightEventId, lifecycleState });
  }).pipe(Effect.mapError((failure) => toApiFailure({ failure, insightEventId, caller })));

const moveInsightAtomically = (movement: InsightMovement) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(moveInsight(movement))).pipe(
    Effect.catchTag("SqlError", Effect.die)
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
}) =>
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
    .handle("listPendingInsights", ({ request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const insights = yield* listPendingInsights(userId);
        const first = insights[0];

        return {
          data: insights,
          next:
            first === undefined
              ? []
              : nextLifecycleOperations({
                  insightEventId: first.id,
                  current: first.lifecycleState,
                  caller,
                }),
        };
      })
    )
    .handle("markInsightDelivered", ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const result = yield* deliverInsight({
          userId,
          insightEventId: params.id,
          input: payload,
          caller,
        });

        return {
          data: result,
          next: nextLifecycleOperations({
            insightEventId: params.id,
            current: result.insight.lifecycleState,
            caller,
          }),
        };
      })
    )
    .handle("markInsightRead", ({ params, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const insight = yield* moveInsightAtomically({
          userId,
          insightEventId: params.id,
          target: "read",
          caller,
        });

        return {
          data: insight,
          next: nextLifecycleOperations({
            insightEventId: params.id,
            current: insight.lifecycleState,
            caller,
          }),
        };
      })
    )
    .handle("dismissInsight", ({ params, request }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId: userId } = yield* resolveCaller(request);
        const caller = suggestedOperationCaller(scopes);
        const insight = yield* moveInsightAtomically({
          userId,
          insightEventId: params.id,
          target: "dismissed",
          caller,
        });

        return { data: insight, next: [] };
      })
    )
);
