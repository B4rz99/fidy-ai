import { type Crypto, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type HttpServerRequest } from "effect/unstable/http";
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
import { resolveCaller } from "~/shell/_shared/authz";
import { type Unauthenticated } from "~/shell/_shared/errors";
import { type SuggestedOperation } from "~/shell/_shared/response";
import { type SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { type InsightApiFailure, nextLifecycleOperations, toApiFailure } from "./errors";
import {
  appendDeliveryAttempt,
  listPendingInsights,
  lockInsightEvent,
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

const resolveInsightCaller = (
  request: HttpServerRequest.HttpServerRequest
): Effect.Effect<
  { userId: UserId; caller: SuggestedOperationCaller },
  Unauthenticated,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.map(resolveCaller(request), ({ scopes, subjectUserId }) => ({
    userId: subjectUserId,
    caller: suggestedOperationCaller(scopes),
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

const moveInsightAtomically = (
  movement: InsightMovement
): Effect.Effect<InsightEvent, InsightApiFailure, SqlClient.SqlClient> =>
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
    .handle("listPendingInsights", ({ request }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller(request);
        const insights = yield* listPendingInsights(userId);
        const first = insights[0];

        return {
          data: insights,
          next: first === undefined ? [] : insightLifecycleOperations(first, caller),
        };
      })
    )
    .handle("markInsightDelivered", ({ params, payload, request }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller(request);
        const result = yield* deliverInsight({
          userId,
          insightEventId: params.id,
          input: payload,
          caller,
        });

        return { data: result, next: insightLifecycleOperations(result.insight, caller) };
      })
    )
    .handle("markInsightRead", ({ params, request }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller(request);
        const insight = yield* moveInsightAtomically({
          userId,
          insightEventId: params.id,
          target: "read",
          caller,
        });

        return { data: insight, next: insightLifecycleOperations(insight, caller) };
      })
    )
    .handle("dismissInsight", ({ params, request }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveInsightCaller(request);
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
