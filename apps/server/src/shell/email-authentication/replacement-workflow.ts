import { type Cause, Config, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlError } from "effect/unstable/sql";
import { Activity, DurableClock } from "effect/unstable/workflow";
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
  attempt: 1 | 2 | 3
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
      duration: "1 minute",
      inMemoryThreshold: "0 millis",
    });
  }
});

/** Registers named, secret-free Activity results and restart-safe bounded retry waits. */
export const ReplacementDeliveryWorkflowLive = ReplacementDeliveryWorkflow.toLayer(
  Effect.fn("EmailReplacementDelivery.run")(function* (payload) {
    for (const attempt of [1, 2, 3] as const) {
      const result = yield* deliverAttempt(payload, attempt);
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

/** SQL outages are sanitized and durably retried; failed cleanup never becomes terminal success. */
export const ReplacementExpiryWorkflowLive = ReplacementExpiryWorkflow.toLayer(
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
            : "1 minute",
        inMemoryThreshold: "0 millis",
      });
    }
  })
);

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
