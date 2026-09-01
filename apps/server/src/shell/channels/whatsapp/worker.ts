import { Cause, DateTime, Effect, Layer, Option } from "effect";
import { dual } from "effect/Function";
import { AgentService } from "~/shell/agent/agent-service";
import { projectStack } from "~/shell/observability/projectors";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import { Telemetry } from "~/shell/observability/telemetry";
import { TelemetryCount } from "~/shell/observability/protocol";
import { processDueConsentDisclosureDelivery } from "./disclosure-delivery";
import type { sendKapsoFreeForm } from "./outbound";
import { deliverPreparedReply } from "./reply-delivery";
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

type StartedTurn = Effect.Success<ReturnType<typeof startWhatsAppTurn>>;
type DeliveryError = Effect.Error<ReturnType<typeof sendKapsoFreeForm>>;
const logDeliveryError = (error: DeliveryError): Effect.Effect<void> =>
  error._tag === "KapsoSendFailed"
    ? Effect.logError("WhatsApp Kapso send failed", {
        safeReason: error.safeReason,
        deliveryCertainty: error.deliveryCertainty,
      })
    : Effect.logError("WhatsApp delivery policy failed", { error: error._tag });

const processStartedTurn = Effect.fn(function* (input: {
  readonly started: StartedTurn;
  readonly claimTime: DateTime.Utc;
}) {
  const { claim, inboundMessage } = input.started;
  const service = yield* AgentService;
  const handled = yield* service
    .handleMessage(
      claim.userId,
      inboundMessage,
      (reply) => deliverPreparedReply({ userId: claim.userId, reply }).pipe(Effect.asVoid),
      "verified-whatsapp"
    )
    .pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: () => ({ _tag: "Success" as const }),
      })
    );
  if (handled._tag === "Success") {
    yield* completeWhatsAppTurn(claim, input.claimTime);
    return true;
  }
  if (handled.error._tag === "KapsoSendFailed") {
    yield* logDeliveryError(handled.error);
    yield* failWhatsAppTurn(claim, input.claimTime, "send_failed");
    return true;
  }
  yield* logAgentTurnError(handled.error);
  yield* failWhatsAppTurn(
    claim,
    input.claimTime,
    handled.error._tag === "WhatsAppEvidenceConflict" ? "send_failed" : "agent_failed"
  );
  return true;
});

const continueStartedTurn = (
  started: StartedTurn,
  claimTime: DateTime.Utc
): Effect.Effect<boolean, never, Effect.Services<ReturnType<typeof processStartedTurn>>> =>
  Effect.gen(function* () {
    const work = processStartedTurn({ started, claimTime });
    const telemetry = yield* Effect.serviceOption(Telemetry);
    return yield* Option.match(telemetry, {
      onNone: () => work,
      onSome: (service) =>
        service.continueSpan(
          Option.getOrUndefined(started.propagation),
          {
            component: "whatsapp",
            operation: "whatsapp.processTurn",
            trigger: "queue",
            spanOperation: "queue.process",
            workKind: "queue_attempt",
            metadata: {
              _tag: "Queue",
              attempt: started.processingAttempt,
              inputCount: TelemetryCount.make(started.inputCount),
              delayMilliseconds: started.queueDelayMilliseconds,
            },
          },
          work
        ),
    });
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
  return yield* continueStartedTurn(started.value, claimTime);
});

/**
 * Repeats `iteration`, using `operation` as its telemetry label. Pure interruption propagates to
 * the caller. Every other Cause is projected to safe log coordinates, captured in full by the
 * telemetry boundary, swallowed, and followed by a one-second delay before the next iteration.
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
    yield* Effect.logInfo("Applied WhatsApp operational retention");
  })
);

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

/** Runs independently supervised disclosure-retry, durable-turn, and retention loops. */
export const WhatsAppWorkerLive = Layer.effectDiscard(
  Effect.all(
    [...Array.from({ length: 8 }, () => workerLoop), retentionLoop].map((loop) =>
      Effect.forkScoped(loop)
    ),
    { concurrency: "unbounded", discard: true }
  )
);
