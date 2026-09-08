import { Cause, DateTime, Effect, Layer, Option } from "effect";
import { dual } from "effect/Function";
import { AgentService } from "~/shell/agent/agent-service";
import { pruneCompletedHostedTurnMessages } from "~/shell/durable-execution-retention";
import { projectStack } from "~/shell/observability/projectors";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import { Telemetry } from "~/shell/observability/telemetry";
import { processDueConsentDisclosureDelivery } from "./disclosure-delivery";
import { claimWhatsAppTurn, failWhatsAppTurn, pruneWhatsAppOperationalData } from "./repo";

const projectCauseForLog = (
  cause: Cause.Cause<unknown>
): Readonly<{
  reasons: ReadonlyArray<string>;
  stack: ReturnType<typeof projectStack>;
}> => ({ reasons: cause.reasons.map((reason) => reason._tag), stack: projectStack(cause) });

/** Hands one due burst to durable hosted execution; only pre-handoff legacy claims use the old timer. */
export const processNextWhatsAppTurn = Effect.fn("WhatsApp.processNextTurn")(function* (
  claimTime: DateTime.Utc
) {
  const claimed = yield* claimWhatsAppTurn(claimTime);
  if (Option.isNone(claimed)) return false;
  const claim = claimed.value;
  if (claim.action === "retire_ambiguous") {
    yield* failWhatsAppTurn(claim, claimTime, "ambiguous_crash");
    return true;
  }
  const agent = yield* AgentService;
  yield* agent.handleWhatsAppClaim(claim, claimTime);
  return true;
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

const workerLoop = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const retriedDisclosure = yield* processDueConsentDisclosureDelivery(now);
  const processed = retriedDisclosure ? true : yield* processNextWhatsAppTurn(now);
  if (!processed) yield* Effect.sleep("250 millis");
}).pipe(runSupervisedWhatsAppLoop("whatsapp.processWork"));

/** Removes expired WhatsApp operational data as one independently observed scheduled execution. */
export const runWhatsAppRetention = runScheduledWork({
  component: "whatsapp",
  schedule: "task.whatsappRetention",
  operationalError: "database_unavailable",
})(
  Effect.gen(function* () {
    yield* pruneWhatsAppOperationalData();
    yield* pruneCompletedHostedTurnMessages(yield* DateTime.now);
    yield* Effect.logInfo("Applied WhatsApp operational retention");
  })
);

const retentionLoop = Effect.forever(
  runWhatsAppRetention.pipe(
    Effect.andThen(Effect.sleep("1 hour")),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)
        ? Effect.interrupt
        : Effect.sleep("1 second")
    )
  )
);

/** Runs independently supervised disclosure-retry, durable-turn, and retention loops. */
export const WhatsAppWorkerLive = Layer.effectDiscard(
  Effect.forEach(
    [...Array.from({ length: 8 }, () => workerLoop), retentionLoop],
    (loop) => Effect.forkScoped(loop),
    { concurrency: "unbounded", discard: true }
  )
);
