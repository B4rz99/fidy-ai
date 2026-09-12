import { Cause, DateTime, Effect, Layer, Option } from "effect";
import { dual } from "effect/Function";
import { AgentService, isDurableTransportRetryCause } from "~/shell/agent/agent-service";
import { pruneCompletedHostedTurnMessages } from "~/shell/durable-execution-retention";
import { projectStack } from "~/shell/observability/projectors";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import { Telemetry } from "~/shell/observability/telemetry";
import { maximumWhatsAppInboundAttempts, whatsappInboundQueue } from "./inbound-execution";
import {
  pruneWhatsAppOperationalData,
  pruneWhatsAppQueueHistory,
  retireExhaustedWhatsAppWork,
} from "./repo";

const projectCauseForLog = (
  cause: Cause.Cause<unknown>
): Readonly<{
  reasons: ReadonlyArray<string>;
  stack: ReturnType<typeof projectStack>;
}> => ({ reasons: cause.reasons.map((reason) => reason._tag), stack: projectStack(cause) });

/** Takes and settles one durable accepted message without imposing an execution deadline. */
export const processNextWhatsAppTurn = Effect.fn("WhatsApp.processNextTurn")(function* () {
  const queue = yield* whatsappInboundQueue;
  const agent = yield* AgentService;
  return yield* queue
    .take((work) => agent.handleWhatsAppWork(work), {
      maxAttempts: maximumWhatsAppInboundAttempts,
    })
    .pipe(Effect.as(true));
});

/**
 * Supervises bounded channel iterations. Interruption propagates; other failures receive only
 * metadata-safe telemetry and a one-second retry delay, never a payload-shaped log.
 */
export const runSupervisedWhatsAppLoop: {
  (
    operation: "whatsapp.processWork"
  ): <E, R>(iteration: Effect.Effect<void, E, R>) => Effect.Effect<never, never, R | Telemetry>;
  <E, R>(
    iteration: Effect.Effect<void, E, R>,
    operation: "whatsapp.processWork"
  ): Effect.Effect<never, never, R | Telemetry>;
} = dual(
  2,
  <E, R>(
    iteration: Effect.Effect<void, E, R>,
    operation: "whatsapp.processWork"
  ): Effect.Effect<never, never, R | Telemetry> =>
    Effect.forever(
      iteration.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)) {
            return Effect.interrupt;
          }
          if (isDurableTransportRetryCause(cause)) {
            // A classified transient exchange is expected to be re-delivered by the persisted
            // queue and is never an unexpected defect, so the loop reports no failure event for it.
            return Effect.logWarning("WhatsApp background iteration will retry", {
              operation,
            }).pipe(Effect.andThen(Effect.sleep("1 second")));
          }
          return Effect.gen(function* () {
            yield* Effect.logError("WhatsApp background iteration failed", {
              cause: projectCauseForLog(cause),
              hasFailures: Cause.hasFails(cause),
              hasDefects: Cause.hasDies(cause),
              hasInterrupts: Cause.hasInterrupts(cause),
            });
            const telemetry = yield* Telemetry;
            yield* telemetry.captureFailure({
              _tag: "Defect",
              component: "whatsapp",
              operation,
              error: "unexpected_defect",
              cause,
            });
            yield* Effect.sleep("1 second");
          });
        })
      )
    )
);

const workerLoop = processNextWhatsAppTurn().pipe(
  Effect.asVoid,
  runSupervisedWhatsAppLoop("whatsapp.processWork")
);

/** Removes expired WhatsApp operational data as one independently observed scheduled execution. */
export const runWhatsAppRetention = runScheduledWork({
  component: "whatsapp",
  schedule: "task.whatsappRetention",
  operationalError: "database_unavailable",
})(
  Effect.gen(function* () {
    yield* pruneWhatsAppOperationalData();
    const now = yield* DateTime.now;
    const telemetry = yield* Telemetry;
    const retired = yield* retireExhaustedWhatsAppWork(now);
    yield* Effect.forEach(
      retired,
      () =>
        telemetry.captureFailure({
          _tag: "ExhaustedOperationalFailure",
          component: "whatsapp",
          operation: "whatsapp.processWork",
          error: "operational_failure",
          provider: Option.none(),
          retryable: false,
          cause: "Exhausted WhatsApp inbound work",
        }),
      { discard: true }
    );
    yield* pruneWhatsAppQueueHistory(now);
    yield* pruneCompletedHostedTurnMessages(now);
    yield* Effect.logInfo("Applied WhatsApp operational retention");
  })
);

/** Best-effort operational cleanup; authoritative expiry checks remain in owning operations. */
export const WhatsAppRetentionLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: "1 hour",
    work: runWhatsAppRetention.pipe(Effect.ignoreCause),
  }).pipe(Effect.forkScoped)
);

/** Runs bounded native queue consumers; disclosure Workflows and retention run separately. */
export const WhatsAppWorkerLive = Layer.effectDiscard(
  Effect.forEach(
    Array.from({ length: 8 }, () => workerLoop),
    (loop) => Effect.forkScoped(loop),
    { concurrency: "unbounded", discard: true }
  )
);
