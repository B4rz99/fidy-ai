import { Config, Crypto, DateTime, Effect, Layer, Option, Result } from "effect";
import { EmailDeliveryClaimToken } from "~/core/email-authentication/model";
import {
  EmailDeliveryPort,
  type EmailDeliveryPortService,
  type EmailSendFailed,
} from "~/shell/email-authentication/delivery";
import {
  claimAndArmEmailDeliveryIntent,
  reconcileExpiredArmedClaims,
  settleEmailDelivery,
} from "~/shell/email-authentication/repo";
import { TelemetryAttempt } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";

const maximumSendAttempts = 3;
const initialRetryDelayMillis = 250;
/** Time reserved for one worker to finish all retries before another may recover the delivery. */
const deliveryClaimLeaseSeconds = 60;

const observeSendAttempt = Effect.fn("EmailAuthentication.observeSendAttempt")(function* (
  send: Effect.Effect<void, EmailSendFailed>,
  attempt: number
) {
  const telemetry = yield* Effect.serviceOption(Telemetry);
  const observed = Option.match(telemetry, {
    onNone: () => send,
    onSome: (service) =>
      service.span(
        {
          component: "resend",
          operation: "provider.request",
          trigger: "queue",
          spanOperation: "http.client",
          workKind: "provider_call",
          metadata: {
            _tag: "Provider",
            provider: "resend",
            attempt: TelemetryAttempt.make(attempt),
            status: Option.none(),
          },
        },
        send.pipe(
          Effect.tap(() =>
            service.recordOutcome({
              outcome: "succeeded",
              error: Option.none(),
              retryable: false,
            })
          ),
          Effect.tapError((failure) =>
            failure.certainty === "rejected" && !failure.retryable
              ? service.recordOutcome({
                  outcome: "rejected",
                  error: Option.some("invalid_response"),
                  retryable: false,
                })
              : service.recordOutcome({
                  outcome: "failed",
                  error: Option.some("provider_unavailable"),
                  retryable: failure.retryable,
                })
          )
        )
      ),
  });
  return yield* Effect.result(observed);
});

const captureTerminalSendFailure = Effect.fn("EmailAuthentication.captureTerminalSendFailure")(
  function* (failure: EmailSendFailed) {
    const telemetry = yield* Effect.serviceOption(Telemetry);
    yield* Option.match(telemetry, {
      onNone: () => Effect.void,
      onSome: (service) =>
        service.captureFailure({
          _tag: "ExhaustedOperationalFailure",
          component: "resend",
          operation: "provider.request",
          error: failure.certainty === "rejected" ? "invalid_response" : "provider_unavailable",
          provider: Option.some("resend"),
          retryable: failure.retryable,
          cause: failure,
        }),
    });
  }
);

const sendWithBoundedRetry = Effect.fn("EmailAuthentication.sendWithBoundedRetry")(function* (
  input: Parameters<EmailDeliveryPortService["send"]>[0]
) {
  const sender = yield* EmailDeliveryPort;
  let attempt = 1;
  while (attempt <= maximumSendAttempts) {
    const result = yield* observeSendAttempt(sender.send(input), attempt);
    if (Result.isSuccess(result)) return "sent" as const;
    const terminal =
      result.failure.certainty === "ambiguous" ||
      !result.failure.retryable ||
      attempt === maximumSendAttempts;
    if (terminal) {
      yield* captureTerminalSendFailure(result.failure);
      return result.failure.certainty === "ambiguous"
        ? ("uncertain" as const)
        : ("rejected" as const);
    }
    yield* Effect.sleep(`${initialRetryDelayMillis * 2 ** (attempt - 1)} millis`);
    attempt += 1;
  }
  return "uncertain" as const;
});

/** Processes at most one intent, keeping the raw proof inside this worker turn only. */
export const processOneOnboardingDelivery = Effect.fn("OnboardingDelivery.processOne")(
  function* () {
    const reconciliationTime = yield* DateTime.now;
    yield* reconcileExpiredArmedClaims(reconciliationTime);
    const crypto = yield* Crypto.Crypto;
    const claimToken = EmailDeliveryClaimToken.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    const claimedAt = yield* DateTime.now;
    const claimed = yield* claimAndArmEmailDeliveryIntent({
      claimToken,
      claimedAt,
      claimExpiresAt: DateTime.add(claimedAt, { seconds: deliveryClaimLeaseSeconds }),
    });
    if (Option.isNone(claimed)) return false;

    const intent = claimed.value;
    const deliveryStatus = yield* sendWithBoundedRetry({
      to: intent.email,
      combinedCode: intent.combinedCode,
      idempotencyKey: intent.idempotencyKey,
    }).pipe(
      Effect.withSpan("emailAuthentication.deliverVerification", {
        attributes: { "fidy.email.delivery_generation": intent.generation },
      })
    );
    yield* settleEmailDelivery({
      intent,
      status: deliveryStatus,
      providerMessageId: Option.none(),
    });
    return true;
  }
);

export const OnboardingDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    yield* processOneOnboardingDelivery().pipe(
      Effect.delay("1 second"),
      Effect.forever,
      Effect.forkScoped
    );
  })
);
