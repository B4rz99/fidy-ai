import {
  type Cause,
  Config,
  type Crypto,
  DateTime,
  type Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import { type SqlClient, SqlError } from "effect/unstable/sql";
import { Activity, DurableClock, type WorkflowEngine } from "effect/unstable/workflow";
import type { EmailDeliveryPort } from "./delivery";
import { performReplacementAttempt } from "./replacement-delivery-worker";
import {
  ReplacementAttemptResult,
  type ReplacementDeliveryPayload,
  ReplacementDeliveryWorkflow,
  type ReplacementExpiryPayload,
  ReplacementExpiryWorkflow,
  replacementDeliveryQueue,
  replacementExpiryQueue,
} from "./replacement-protocol";
import { expireReplacement, findReplacementExpiry } from "./replacement-retention";

const DatabaseUnavailable = Schema.TaggedStruct("DatabaseUnavailable", {});
const sanitizeDatabaseFailure = Effect.catchCause((cause: Cause.Cause<never>) =>
  cause.reasons.every((reason) => reason._tag === "Die" && SqlError.isSqlError(reason.defect))
    ? Effect.succeed({ _tag: "DatabaseUnavailable" } as const)
    : Effect.failCause(cause)
);

const deliverAttempt = Effect.fn("EmailReplacementDelivery.attempt")(function* (
  payload: ReplacementDeliveryPayload,
  attempt: 1 | 2 | 3,
  databaseRetryDuration: Duration.Input
) {
  for (let databaseAttempt = 1; ; databaseAttempt++) {
    const result = yield* Activity.make({
      name: `DeliverReplacementEmail/${attempt}`,
      success: Schema.Union([ReplacementAttemptResult, DatabaseUnavailable]),
      execute: performReplacementAttempt(payload, attempt).pipe(sanitizeDatabaseFailure),
    }).pipe(Effect.provideService(Activity.CurrentAttempt, databaseAttempt));
    if (typeof result === "string") return result;
    // Re-enter the SAME logical provider attempt. Armed evidence reconciles to uncertain, not resend.
    yield* DurableClock.sleep({
      name: `ReplacementDatabaseRetry/${attempt}/${databaseAttempt}`,
      duration: databaseRetryDuration,
      inMemoryThreshold: "0 millis",
    });
  }
});

/** Builds delivery execution with a durable database retry appropriate to its runtime. */
export const replacementDeliveryWorkflowLayer = (
  databaseRetryDuration: Duration.Input
): Layer.Layer<
  never,
  never,
  Crypto.Crypto | EmailDeliveryPort | SqlClient.SqlClient | WorkflowEngine.WorkflowEngine
> =>
  ReplacementDeliveryWorkflow.toLayer(
    Effect.fn("EmailReplacementDelivery.run")(function* (payload) {
      for (const attempt of [1, 2, 3] as const) {
        const result = yield* deliverAttempt(payload, attempt, databaseRetryDuration);
        if (result !== "retry") return result;
        yield* DurableClock.sleep({
          name: `ReplacementRetry/${attempt}`,
          duration: attempt === 1 ? "250 millis" : "500 millis",
          inMemoryThreshold: "0 millis",
        });
      }
      return "rejected" as const;
    })
  );

/** Registers named Activities and production's one-minute durable database retry. */
export const ReplacementDeliveryWorkflowLive = replacementDeliveryWorkflowLayer("1 minute");

const ExpiryCheck = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("Waiting", { deadline: Schema.DateTimeUtc }),
  DatabaseUnavailable,
]);

const checkExpiry = Effect.fn("EmailReplacementExpiry.check")(function* (
  payload: ReplacementExpiryPayload
) {
  const deadline = yield* findReplacementExpiry(payload);
  if (Option.isNone(deadline)) return { _tag: "Done" } as const;
  const now = yield* DateTime.now;
  if (DateTime.toEpochMillis(deadline.value.expiresAt) > DateTime.toEpochMillis(now)) {
    return { _tag: "Waiting", deadline: deadline.value.expiresAt } as const;
  }
  yield* expireReplacement(payload);
  return { _tag: "Done" } as const;
}, sanitizeDatabaseFailure);

/** Builds expiry execution with a durable database retry appropriate to its runtime. */
export const replacementExpiryWorkflowLayer = (
  databaseRetryDuration: Duration.Input
): Layer.Layer<never, never, SqlClient.SqlClient | WorkflowEngine.WorkflowEngine> =>
  ReplacementExpiryWorkflow.toLayer(
    Effect.fn("EmailReplacementExpiry.run")(function* (payload) {
      for (let attempt = 1; ; attempt++) {
        const result = yield* Activity.make({
          name: `CheckReplacementExpiry/${attempt}`,
          success: ExpiryCheck,
          execute: checkExpiry(payload),
        });
        if (result._tag === "Done") return;
        const now = yield* DateTime.now;
        yield* DurableClock.sleep({
          name: `ReplacementExpiry/${attempt}`,
          duration:
            result._tag === "Waiting"
              ? Math.max(0, DateTime.toEpochMillis(result.deadline) - DateTime.toEpochMillis(now))
              : databaseRetryDuration,
          inMemoryThreshold: "0 millis",
        });
      }
    })
  );

/** Registers expiry Activities and production's one-minute durable database retry. */
export const ReplacementExpiryWorkflowLive = replacementExpiryWorkflowLayer("1 minute");

/** Queue consumers durably submit without holding a queue lease for the entire proof lifetime. */
export const EmailReplacementDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    const delivery = yield* replacementDeliveryQueue;
    const expiry = yield* replacementExpiryQueue;
    yield* delivery
      .take((payload) => ReplacementDeliveryWorkflow.execute(payload, { discard: true }))
      .pipe(Effect.forever, Effect.forkScoped);
    yield* expiry
      .take((payload) => ReplacementExpiryWorkflow.execute(payload, { discard: true }))
      .pipe(Effect.forever, Effect.forkScoped);
  })
);
