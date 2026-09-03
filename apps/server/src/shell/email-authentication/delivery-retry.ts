import { Effect, Option, Result } from "effect";
import { Activity } from "effect/unstable/workflow";
import type { EmailDeliveryPortService, EmailSendFailed } from "./delivery";
import { EmailDeliveryPort } from "./delivery";
import { TelemetryAttempt } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";

const maximumSendAttempts = 3;
const initialRetryDelayMillis = 250;

const observeSendAttempt = Effect.fn(function* (
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
            service.recordOutcome({ outcome: "succeeded", error: Option.none(), retryable: false })
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

const captureTerminalSendFailure = Effect.fn(function* (failure: EmailSendFailed) {
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
});

const failureStatus = (failure: EmailSendFailed): "uncertain" | "rejected" =>
  failure.certainty === "ambiguous" ? ("uncertain" as const) : ("rejected" as const);

/** Executes one observed provider attempt and preserves its typed failure for its owning executor. */
export const attemptEmailDelivery = Effect.fn("EmailAuthentication.attemptDelivery")(function* (
  input: Parameters<EmailDeliveryPortService["send"]>[0]
) {
  const sender = yield* EmailDeliveryPort;
  const attempt = yield* Activity.CurrentAttempt;
  const result = yield* observeSendAttempt(sender.send(input), attempt);
  if (Result.isSuccess(result)) return;
  return yield* result.failure;
});

/** Records an exhausted provider failure once and projects its truthful domain settlement. */
export const settleTerminalEmailFailure = Effect.fn("EmailAuthentication.settleTerminalFailure")(
  function* (failure: EmailSendFailed) {
    yield* captureTerminalSendFailure(failure);
    return failureStatus(failure);
  }
);

/** Executes the bounded Resend retry policy retained by non-workflow email deliveries. */
export const sendEmailWithBoundedRetry = Effect.fn("EmailAuthentication.sendWithBoundedRetry")(
  function* (input: Parameters<EmailDeliveryPortService["send"]>[0]) {
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
        return failureStatus(result.failure);
      }
      yield* Effect.sleep(`${initialRetryDelayMillis * 2 ** (attempt - 1)} millis`);
      attempt += 1;
    }
    return "uncertain" as const;
  }
);
