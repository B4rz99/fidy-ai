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
import { Activity, type WorkflowEngine } from "effect/unstable/workflow";
import type { ApplicationPersistedQueueHandlerPolicy } from "~/shell/_shared/persisted-queue";
import { sleepFor, sleepUntil } from "~/shell/durable-execution-clock";
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

/** Bounded provider attempt ordinals, and the stride that keeps re-entered attempts distinct. */
const replacementDeliveryAttempts = [1, 2, 3] as const;
const maximumReplacementDeliveryAttempts = replacementDeliveryAttempts.length;
type ReplacementDeliveryAttempt = (typeof replacementDeliveryAttempts)[number];

const ReplacementAttemptOutcome = Schema.Union([ReplacementAttemptResult, DatabaseUnavailable]);
const ExpiryCheck = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("Waiting", { deadline: Schema.DateTimeUtc }),
  DatabaseUnavailable,
]);

/** Stable durable identities of replacement Activities. */
export const replacementActivityIdentities = {
  deliver: { name: "DeliverReplacementEmail", success: ReplacementAttemptOutcome },
  checkExpiry: { name: "CheckReplacementExpiry", success: ExpiryCheck },
} as const;

/** Stable DurableClock identity for one retry wait at a specific database attempt. */
export const replacementDatabaseRetryClockName = (input: {
  readonly attempt: ReplacementDeliveryAttempt;
  readonly databaseAttempt: number;
}): string => `ReplacementDatabaseRetry/${input.attempt}/${input.databaseAttempt}`;
/** Stable expiry-clock identity for one expiry check attempt. */
export const replacementExpiryClockName = (attempt: number): string =>
  `ReplacementExpiry/${attempt}`;

const deliverAttempt = Effect.fn("EmailReplacementDelivery.attempt")(function* (
  payload: ReplacementDeliveryPayload,
  attempt: ReplacementDeliveryAttempt,
  databaseRetryDuration: Duration.Input
) {
  for (let databaseAttempt = 1; ; databaseAttempt++) {
    // The stable name carries no ordinal; interleaving the bounded provider attempt with the
    // unbounded database retry keeps every re-entry a distinct durable request.
    const result = yield* Activity.make({
      name: "DeliverReplacementEmail",
      success: Schema.Union([ReplacementAttemptResult, DatabaseUnavailable]),
      execute: performReplacementAttempt(payload, attempt).pipe(sanitizeDatabaseFailure),
    }).pipe(
      Effect.provideService(
        Activity.CurrentAttempt,
        (databaseAttempt - 1) * maximumReplacementDeliveryAttempts + attempt
      )
    );
    if (typeof result === "string") return result;
    // Re-enter the SAME logical provider attempt. Armed evidence reconciles to uncertain, not resend.
    yield* sleepFor(
      replacementDatabaseRetryClockName({ attempt, databaseAttempt }),
      databaseRetryDuration
    );
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
      for (const attempt of replacementDeliveryAttempts) {
        const result = yield* deliverAttempt(payload, attempt, databaseRetryDuration);
        if (result !== "retry") return result;
        // Fixed sub-second provider pacing uses ordinary Effect time; only the database retry and
        // the expiry deadline need restart survival.
        yield* Effect.sleep(attempt === 1 ? "250 millis" : "500 millis");
      }
      return "rejected" as const;
    })
  );

/** Registers named Activities and production's one-minute durable database retry. */
export const ReplacementDeliveryWorkflowLive = replacementDeliveryWorkflowLayer("1 minute");

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
          name: "CheckReplacementExpiry",
          success: ExpiryCheck,
          execute: checkExpiry(payload),
        }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt));
        if (result._tag === "Done") return;
        if (result._tag === "Waiting") {
          yield* sleepUntil(replacementExpiryClockName(attempt), result.deadline);
        } else {
          yield* sleepFor(replacementExpiryClockName(attempt), databaseRetryDuration);
        }
      }
    })
  );

/** Registers expiry Activities and production's one-minute durable database retry. */
export const ReplacementExpiryWorkflowLive = replacementExpiryWorkflowLayer("1 minute");

const ReplacementQueueTransient = Schema.TaggedStruct("ReplacementQueueTransient", {
  reason: Schema.Literal("database-unavailable"),
});
type ReplacementQueueTransient = typeof ReplacementQueueTransient.Type;

const isRetryableDatabaseCause = (cause: Cause.Cause<never>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) =>
      reason._tag === "Die" && SqlError.isSqlError(reason.defect) && reason.defect.isRetryable
  );

/** Reifies retryable database defects before the mandatory queue disposition boundary. */
export const classifyReplacementQueueFailure = <A, R>(
  work: Effect.Effect<A, never, R>
): Effect.Effect<A, ReplacementQueueTransient, R> =>
  work.pipe(
    Effect.catchCauseIf(isRetryableDatabaseCause, () =>
      Effect.fail({
        _tag: "ReplacementQueueTransient",
        reason: "database-unavailable",
      } as const)
    )
  );

/** Email Replacement queue attempts retry only transient database unavailability. */
export const replacementQueueHandlerPolicy: ApplicationPersistedQueueHandlerPolicy<
  ReplacementDeliveryPayload | ReplacementExpiryPayload,
  ReplacementQueueTransient,
  never,
  never
> = {
  classify: (_failure: ReplacementQueueTransient) =>
    ({
      _tag: "Retry",
      reason: "transient",
    }) as const,
  recordTerminal: () => Effect.void,
};

/**
 * Claims one delivery item and completes it after durable Workflow submission. A transient marker
 * releases the item for retry; interruption releases it without consuming an attempt. Provider
 * delivery and settlement continue in the Workflow after this call returns.
 */
export const consumeReplacementDelivery = Effect.fn(function* () {
  const queue = yield* replacementDeliveryQueue;
  yield* queue.take(
    (payload) =>
      classifyReplacementQueueFailure(
        ReplacementDeliveryWorkflow.execute(payload, { discard: true })
      ),
    replacementQueueHandlerPolicy
  );
});

/**
 * Claims one expiry item and completes it after durable Workflow submission. A transient marker
 * releases the item for retry; interruption releases it without consuming an attempt. Deadline
 * waiting and expiry continue in the Workflow after this call returns.
 */
export const consumeReplacementExpiry = Effect.fn(function* () {
  const queue = yield* replacementExpiryQueue;
  yield* queue.take(
    (payload) =>
      classifyReplacementQueueFailure(
        ReplacementExpiryWorkflow.execute(payload, { discard: true })
      ),
    replacementQueueHandlerPolicy
  );
});

const delayFailedTake = Effect.catch(() => Effect.sleep("1 second"));

/** Queue consumers durably submit without holding a queue lease for the entire proof lifetime. */
export const EmailReplacementDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    // The Work remains the existing Workflow submission; this boundary changes only its failure
    // projection, so a second span or operation metric would duplicate the Workflow observation.
    yield* consumeReplacementDelivery().pipe(delayFailedTake, Effect.forever, Effect.forkScoped);
    yield* consumeReplacementExpiry().pipe(delayFailedTake, Effect.forever, Effect.forkScoped);
  })
);
