import { Context, DateTime, Duration, Effect, Schema } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { AgentReply } from "~/shell/agent/agent-service";
import { TelemetryAttempt } from "~/shell/observability/protocol";
import { type KapsoSendFailed } from "./kapso-client";
import { sendKapsoFreeForm } from "./outbound";

/** Maximum provider calls permitted for one already-generated WhatsApp reply. */
export const DeliveryAttemptLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10 })
).pipe(Schema.brand("DeliveryAttemptLimit"));
export type DeliveryAttemptLimit = typeof DeliveryAttemptLimit.Type;

/** WhatsApp-local bounded delivery policy. */
export type WhatsAppDeliveryPolicy = Readonly<{
  maximumAttempts: DeliveryAttemptLimit;
  rejectedRetryDelay: Duration.Duration;
}>;

/** Production delivery policy; tests may override it without adding deployment configuration. */
export const CurrentDeliveryPolicy = Context.Reference<WhatsAppDeliveryPolicy>(
  "@fidy/server/shell/channels/whatsapp/reply-delivery/CurrentDeliveryPolicy",
  {
    defaultValue: () => ({
      maximumAttempts: DeliveryAttemptLimit.make(3),
      rejectedRetryDelay: Duration.seconds(1),
    }),
  }
);

type WhatsAppDeliveryError = Effect.Error<ReturnType<typeof sendKapsoFreeForm>>;

/** A retry is legal only for a definitive automatic rejection while provider calls remain. */
export type WhatsAppDeliveryDisposition =
  | Readonly<{ _tag: "RetryRejected"; delay: Duration.Duration }>
  | Readonly<{ _tag: "Stop" }>;

const stopDelivery: WhatsAppDeliveryDisposition = { _tag: "Stop" };

const classifyAttemptLimit = (
  attempt: TelemetryAttempt,
  policy: WhatsAppDeliveryPolicy
): WhatsAppDeliveryDisposition =>
  attempt < policy.maximumAttempts
    ? { _tag: "RetryRejected", delay: policy.rejectedRetryDelay }
    : stopDelivery;

const classifyAutomaticRetry = (
  failure: KapsoSendFailed,
  attempt: TelemetryAttempt,
  policy: WhatsAppDeliveryPolicy
): WhatsAppDeliveryDisposition =>
  failure.automaticRetry ? classifyAttemptLimit(attempt, policy) : stopDelivery;

const classifyRejectedDelivery = (
  failure: KapsoSendFailed,
  attempt: TelemetryAttempt,
  policy: WhatsAppDeliveryPolicy
): WhatsAppDeliveryDisposition =>
  failure.deliveryCertainty === "rejected"
    ? classifyAutomaticRetry(failure, attempt, policy)
    : stopDelivery;

/** Classifies a typed delivery failure without inspecting provider bodies or User content. */
export const classifyDeliveryFailure = (input: {
  readonly failure: WhatsAppDeliveryError;
  readonly attempt: TelemetryAttempt;
  readonly policy: WhatsAppDeliveryPolicy;
}): WhatsAppDeliveryDisposition =>
  input.failure._tag === "KapsoSendFailed"
    ? classifyRejectedDelivery(input.failure, input.attempt, input.policy)
    : stopDelivery;

const logRejectedRetry = (
  failure: KapsoSendFailed,
  attempt: TelemetryAttempt
): Effect.Effect<void> =>
  Effect.logWarning("Retrying rejected WhatsApp provider delivery", {
    safeReason: failure.safeReason,
    deliveryCertainty: failure.deliveryCertainty,
    attempt,
  });

/**
 * Delivers one exact prepared reply with bounded provider-rejection retries. The caller retains its
 * existing ConversationContinuity callback, User serialization scope, and processing trace for the
 * entire effect. Typed failure is returned unchanged; interruption is never converted to failure.
 */
export const deliverPreparedReply = Effect.fn("WhatsApp.deliverPreparedReply")(function* (
  input: Readonly<{ userId: UserId; reply: AgentReply }>
) {
  const policy = yield* CurrentDeliveryPolicy;
  const deliver = (attempt: TelemetryAttempt): ReturnType<typeof sendKapsoFreeForm> =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        sendKapsoFreeForm({
          userId: input.userId,
          reply: input.reply,
          now,
          attempt,
        })
      ),
      Effect.catch((failure) => {
        const disposition = classifyDeliveryFailure({ failure, attempt, policy });
        if (disposition._tag === "Stop" || failure._tag !== "KapsoSendFailed") {
          return Effect.fail(failure);
        }
        return logRejectedRetry(failure, attempt).pipe(
          Effect.andThen(Effect.sleep(disposition.delay)),
          Effect.andThen(deliver(TelemetryAttempt.make(attempt + 1)))
        );
      })
    );
  return yield* deliver(TelemetryAttempt.make(1));
});
