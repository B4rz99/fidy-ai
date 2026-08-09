import { Cause, DateTime, Effect, Layer, Option, Schedule } from "effect";
import { dual } from "effect/Function";
import { AgentService } from "~/shell/agent/agent-service";
import { projectStack } from "~/shell/observability/projectors";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import { Telemetry } from "~/shell/observability/telemetry";
import { sendKapsoFreeForm } from "./outbound";
import {
  claimWhatsAppTurn,
  completeWhatsAppTurn,
  failWhatsAppTurn,
  pruneWhatsAppOperationalData,
  startWhatsAppTurn,
} from "./repo";

const logAgentTurnError = (error: { readonly _tag: string }): Effect.Effect<void> =>
  Effect.logError("WhatsApp agent turn failed", { error: error._tag });
const projectCauseForLog = <E extends unknown>(
  cause: Cause.Cause<E>
): Readonly<{ reasons: ReadonlyArray<string>; stack: ReturnType<typeof projectStack> }> => ({
  reasons: cause.reasons.map((reason) => reason._tag),
  stack: projectStack(cause),
});

/** Processes one due User burst, returning false only when no work is due; failures become terminal evidence. */
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

  const started = yield* Effect.option(startWhatsAppTurn(claim, claimTime));
  if (Option.isNone(started)) {
    yield* failWhatsAppTurn(claim, claimTime, "ambiguous_crash");
    return true;
  }

  const service = yield* AgentService;
  const prepared = yield* Effect.option(
    service
      .handleTurn(claim.userId, started.value.inboundMessage)
      .pipe(Effect.tapError(logAgentTurnError))
  );
  if (Option.isNone(prepared)) {
    yield* failWhatsAppTurn(claim, claimTime, "agent_failed");
    return true;
  }

  const sent = yield* Effect.option(
    sendKapsoFreeForm(claim.userId, prepared.value.reply, yield* DateTime.now).pipe(
      Effect.retry({
        while: (error) => error._tag === "KapsoSendFailed" && error.automaticRetry,
        schedule: Schedule.jittered(
          Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 3 }))
        ),
      }),
      Effect.tapError((error) =>
        error._tag === "KapsoSendFailed"
          ? Effect.logError("WhatsApp Kapso send failed", {
              safeReason: error.safeReason,
              deliveryCertainty: error.deliveryCertainty,
            })
          : Effect.logError("WhatsApp delivery policy failed", { error: error._tag })
      )
    )
  );
  if (Option.isNone(sent)) {
    yield* failWhatsAppTurn(claim, claimTime, "send_failed");
    return true;
  }

  yield* service
    .recordDeliveredReply(prepared.value)
    .pipe(Effect.catchTag("OnboardingConsentRequired", () => Effect.void));
  yield* completeWhatsAppTurn(claim, claimTime);
  return true;
});

/**
 * Repeats `iteration`, using `operation` as its telemetry label. Pure interruption propagates to
 * the caller. Every other Cause is projected to safe log coordinates, captured in full by the
 * telemetry boundary, swallowed, and followed by a one-second delay before the next iteration.
 */
export const runSupervisedWhatsAppLoop: {
  (
    operation: "whatsapp.processTurn"
  ): <E, R>(iteration: Effect.Effect<void, E, R>) => Effect.Effect<never, never, R | Telemetry>;
  <E, R>(
    iteration: Effect.Effect<void, E, R>,
    operation: "whatsapp.processTurn"
  ): Effect.Effect<never, never, R | Telemetry>;
} = dual(
  2,
  <E, R>(
    iteration: Effect.Effect<void, E, R>,
    operation: "whatsapp.processTurn"
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
  const processed = yield* processNextWhatsAppTurn(yield* DateTime.now);
  if (!processed) yield* Effect.sleep("250 millis");
}).pipe(runSupervisedWhatsAppLoop("whatsapp.processTurn"));

/** Removes expired WhatsApp operational data as one independently observed scheduled execution. */
export const runWhatsAppRetention = runScheduledWork({
  component: "whatsapp",
  schedule: "task.whatsappRetention",
  operationalError: "database_unavailable",
})(pruneWhatsAppOperationalData());

const retentionLoop = Effect.forever(
  runWhatsAppRetention.pipe(
    Effect.andThen(Effect.sleep("1 hour")),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)) {
        return Effect.interrupt;
      }
      return Effect.sleep("1 second");
    })
  )
);

/** Runs independently supervised durable turn and retention loops for the application scope. */
export const WhatsAppWorkerLive = Layer.effectDiscard(
  Effect.all(
    [...Array.from({ length: 8 }, () => workerLoop), retentionLoop].map((loop) =>
      Effect.forkScoped(loop)
    ),
    { concurrency: "unbounded", discard: true }
  )
);
