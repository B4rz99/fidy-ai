import { Config, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  Sharding,
} from "effect/unstable/cluster";
import { PersistedQueue } from "effect/unstable/persistence";
import { Activity, Workflow } from "effect/unstable/workflow";
import { EmailDeliveryIntentId } from "~/core/email-authentication/model";
import { durableQueueRetention } from "~/shell/durable-execution-retention";
import {
  attemptEmailDelivery,
  settleTerminalEmailFailure,
} from "~/shell/email-authentication/delivery-retry";
import {
  armOnboardingEmailDelivery,
  findPendingOnboardingEmailDeliveries,
  settleOnboardingEmailDelivery,
  supersedeNotCurrentOnboardingEmailDelivery,
} from "~/shell/email-authentication/repo";

/** Backward-readable, identifier-only request retained by the durable onboarding delivery workflow. */
export const OnboardingDeliveryPayload = Schema.Struct({
  intentId: EmailDeliveryIntentId,
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
}).annotate({ identifier: "OnboardingDeliveryPayload" });
export type OnboardingDeliveryPayload = typeof OnboardingDeliveryPayload.Type;

const OnboardingDeliverySuccess = Schema.Struct({
  outcome: Schema.Literals(["sent", "not-current"]),
}).annotate({ identifier: "OnboardingDeliverySuccess" });

/** Safe expected failure persisted when Resend rejects delivery or leaves its outcome ambiguous. */
export class OnboardingDeliveryFailed extends Schema.Error<OnboardingDeliveryFailed>(
  "OnboardingDeliveryFailed"
)({
  _tag: Schema.tag("OnboardingDeliveryFailed"),
  outcome: Schema.Literals(["rejected", "uncertain"]),
}) {}

/** Durable protocol for one versioned onboarding email-delivery intent. */
export const OnboardingEmailDeliveryWorkflow = Workflow.make("OnboardingEmailDelivery", {
  payload: OnboardingDeliveryPayload,
  success: OnboardingDeliverySuccess,
  error: OnboardingDeliveryFailed,
  idempotencyKey: ({ intentId }) => intentId,
});

const deliveryQueueName = "onboarding-email-delivery";
const workflowEntityType = "Workflow/OnboardingEmailDelivery";
const maximumProviderRetries = 2;

export const onboardingEmailDeliveryQueue = PersistedQueue.make({
  name: deliveryQueueName,
  schema: OnboardingDeliveryPayload,
});

export const performOnboardingEmailDelivery = Effect.fn("OnboardingDelivery.perform")(function* (
  payload: OnboardingDeliveryPayload
) {
  const armedAt = yield* DateTime.now;
  const armed = yield* armOnboardingEmailDelivery(payload.intentId, armedAt);
  if (Option.isNone(armed)) {
    yield* supersedeNotCurrentOnboardingEmailDelivery(payload.intentId, armedAt);
    return { outcome: "not-current" as const };
  }
  if (armed.value._tag === "Uncertain") {
    return yield* OnboardingDeliveryFailed.make({ outcome: "uncertain" });
  }

  const intent = armed.value;
  const sendResult = yield* attemptEmailDelivery({
    purpose: "verified-onboarding",
    to: intent.email,
    combinedCode: intent.combinedCode,
    idempotencyKey: intent.idempotencyKey,
  }).pipe(
    Activity.retry({
      times: maximumProviderRetries,
      while: (failure) => failure.certainty === "rejected" && failure.retryable,
    }),
    Effect.withSpan("emailAuthentication.deliverVerification", {
      attributes: { "fidy.email.delivery_generation": intent.generation },
    }),
    Effect.result
  );
  const status = yield* Result.match(sendResult, {
    onFailure: settleTerminalEmailFailure,
    onSuccess: () => Effect.succeed("sent" as const),
  });
  const settlement = yield* settleOnboardingEmailDelivery({
    intentId: intent.id,
    enrollmentId: intent.enrollmentId,
    generation: intent.generation,
    status,
    providerMessageId: Option.none(),
  });
  if (settlement === "stale") return { outcome: "not-current" as const };
  return status === "sent"
    ? { outcome: "sent" as const }
    : yield* OnboardingDeliveryFailed.make({ outcome: status });
});

const runOnboardingDelivery = Effect.fn("OnboardingDelivery.run")(function* (
  payload: OnboardingDeliveryPayload
) {
  return yield* Activity.make({
    name: "DeliverOnboardingEmail",
    success: OnboardingDeliverySuccess,
    error: OnboardingDeliveryFailed,
    execute: performOnboardingEmailDelivery(payload),
  });
});

/** Registers the onboarding delivery definition with the configured workflow engine. */
export const OnboardingEmailDeliveryWorkflowLive =
  OnboardingEmailDeliveryWorkflow.toLayer(runOnboardingDelivery);

/** Runs native queue consumers that start each transactionally accepted workflow once. */
export const OnboardingEmailDeliveryQueueLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    const queue = yield* onboardingEmailDeliveryQueue;
    const publishPendingPage = Effect.fn("OnboardingDelivery.publishPendingPage")(function* (
      cursor: Option.Option<Readonly<{ id: EmailDeliveryIntentId; createdAt: DateTime.Utc }>>
    ) {
      const pending = yield* findPendingOnboardingEmailDeliveries(cursor);
      yield* Effect.forEach(
        pending,
        ({ id }) => queue.offer({ intentId: id, revision: 1 }, { id }).pipe(Effect.orDie),
        { discard: true }
      );
      return Option.fromUndefinedOr(pending.at(-1));
    });

    const firstPageCursor = yield* publishPendingPage(Option.none());
    yield* queue
      .take((payload) =>
        OnboardingEmailDeliveryWorkflow.execute(payload).pipe(
          Effect.catchTag("OnboardingDeliveryFailed", () => Effect.void),
          Effect.asVoid
        )
      )
      .pipe(Effect.forever, Effect.forkScoped);
    if (Option.isSome(firstPageCursor)) {
      yield* Effect.gen(function* () {
        let cursor: Option.Option<
          Readonly<{ id: EmailDeliveryIntentId; createdAt: DateTime.Utc }>
        > = firstPageCursor;
        while (Option.isSome(cursor)) {
          yield* Effect.sleep("1 minute");
          cursor = yield* publishPendingPage(cursor);
        }
      }).pipe(Effect.forkScoped);
    }
  })
);

/** Transaction-composable publication; duplicate intent identities converge on one queue item. */
export const publishOnboardingEmailDelivery = Effect.fn("OnboardingDelivery.publish")(function* (
  intentId: EmailDeliveryIntentId
) {
  const queue = yield* onboardingEmailDeliveryQueue;
  yield* queue.offer({ intentId, revision: 1 }, { id: intentId }).pipe(Effect.orDie);
});

/** Workflow-owned terminal-state and cleanup protocol used by onboarding retention. */
export const onboardingEmailDeliveryRetention = {
  executionsTerminal: (
    intentIds: ReadonlyArray<EmailDeliveryIntentId>,
    pendingIntentIds: ReadonlyArray<EmailDeliveryIntentId>
  ): ReturnType<(typeof durableQueueRetention)["completed"]> =>
    durableQueueRetention.completed(deliveryQueueName, intentIds, pendingIntentIds),

  clearWorkflowHistory: Effect.fn("OnboardingDelivery.clearWorkflowHistory")(function* (
    intentId: EmailDeliveryIntentId
  ) {
    const storage = yield* MessageStorage.MessageStorage;
    const sharding = yield* Sharding.Sharding;
    const executionId = yield* OnboardingEmailDeliveryWorkflow.executionId({
      intentId,
      revision: 1,
    }).pipe(Effect.orDie);
    const entityId = EntityId.make(executionId);
    yield* storage
      .clearAddress(
        EntityAddress.make({
          entityId,
          entityType: EntityType.make(workflowEntityType),
          shardId: sharding.getShardId(entityId, "default"),
        })
      )
      .pipe(Effect.orDie);
  }),

  removeCompletedQueueItems: (
    intentIds: ReadonlyArray<EmailDeliveryIntentId>
  ): ReturnType<(typeof durableQueueRetention)["removeCompleted"]> =>
    durableQueueRetention.removeCompleted(deliveryQueueName, intentIds),
};

/** Focused test seam for consuming one current queue item without starting a background fiber. */
export const deliverOneOnboardingEmailForTesting = Effect.fn(
  "OnboardingDelivery.deliverOneForTesting"
)(function* () {
  const queue = yield* onboardingEmailDeliveryQueue;
  const completed = yield* queue
    .take((payload) => performOnboardingEmailDelivery(payload).pipe(Effect.ignore))
    .pipe(Effect.as(true), Effect.timeoutOption("2 seconds"));
  return Option.getOrElse(completed, () => false);
});
