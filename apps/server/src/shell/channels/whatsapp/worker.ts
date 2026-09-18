import { Cause, DateTime, Effect, Layer, Option, Schema } from "effect";
import { dual } from "effect/Function";
import type { SqlClient } from "effect/unstable/sql";
import { AgentService, type WhatsAppInboundWorkFailure } from "~/shell/agent/agent-service";
import type { ApplicationPersistedQueueHandlerPolicy } from "~/shell/_shared/persisted-queue";
import {
  type PersistedQueueFailureDisposition,
  PersistedQueueHandlerFailure,
  type PersistedQueueTerminalReason,
} from "~/shell/_shared/persisted-queue-handler";
import { pruneCompletedHostedTurnMessages } from "~/shell/durable-execution-retention";
import { Telemetry, projectStack, runScheduledWork } from "~/shell/observability/operations";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";

import {
  type WhatsAppInboundWork,
  maximumWhatsAppInboundAttempts,
  whatsappInboundConsumerCount,
  whatsappInboundQueue,
} from "./inbound-execution";
import {
  failWhatsAppInboundBurst,
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

const classifyWhatsAppInboundFailure = (
  failure: WhatsAppInboundWorkFailure
): PersistedQueueFailureDisposition => {
  switch (failure._tag) {
    case "HostedTurnUnavailable":
      return { _tag: "Retry", reason: "transient" };
    case "HostedTurnProtocolFailed":
      return { _tag: "Terminal", reason: "payload-rejected" };
    case "WhatsAppInboundRoutingRejected":
      return { _tag: "Terminal", reason: "identity-rejected" };
  }
};

const recordWhatsAppTerminalDisposition = (
  work: WhatsAppInboundWork,
  reason: PersistedQueueTerminalReason
): Effect.Effect<void, never, SqlClient.SqlClient> => {
  // Rejected identity has no domain row owned by the payload User. Record only its bounded reason;
  // never look up or mutate another User's job by identifier.
  if (reason === "identity-rejected") {
    return Effect.logWarning("Rejected WhatsApp inbound queue item: identity-rejected");
  }
  return DateTime.now.pipe(
    Effect.flatMap((failedAt) => failWhatsAppInboundBurst(work, "ambiguous_crash", failedAt))
  );
};

const whatsappInboundHandlerPolicy: ApplicationPersistedQueueHandlerPolicy<
  WhatsAppInboundWork,
  WhatsAppInboundWorkFailure,
  never,
  SqlClient.SqlClient
> = {
  classify: classifyWhatsAppInboundFailure,
  recordTerminal: (work, _metadata, reason) => recordWhatsAppTerminalDisposition(work, reason),
};

/** Takes and settles one durable accepted message without imposing an execution deadline. */
export const processNextWhatsAppTurn = Effect.fn("WhatsApp.processNextTurn")(function* () {
  const queue = yield* whatsappInboundQueue;
  const agent = yield* AgentService;
  return yield* queue
    .take((work) => agent.handleWhatsAppWork(work), whatsappInboundHandlerPolicy, {
      maxAttempts: maximumWhatsAppInboundAttempts,
    })
    .pipe(Effect.as(true));
});

const isSanitizedQueueFailure = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length === 1 &&
  Option.exists(Cause.findErrorOption(cause), Schema.is(PersistedQueueHandlerFailure));

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
          if (isSanitizedQueueFailure(cause)) {
            // The queue boundary already classified or observed this attempt. Supervision delays
            // the next take without duplicating telemetry or rendering the redacted marker.
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
    Array.from({ length: whatsappInboundConsumerCount }, () => workerLoop),
    (loop) => Effect.forkScoped(loop),
    { concurrency: "unbounded", discard: true }
  )
);
