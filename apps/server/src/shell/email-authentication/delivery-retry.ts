import { Effect, Option, Result } from "effect";
import type { EmailDeliveryPortService, EmailSendFailed } from "./delivery";
import { EmailDeliveryPort } from "./delivery";
import { TelemetryAttempt } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";

const maximumSendAttempts = 3;
const initialRetryDelayMillis = 250;

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

/** Executes the one shared bounded Resend retry policy for all email-proof purposes. */
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
        return result.failure.certainty === "ambiguous"
          ? ("uncertain" as const)
          : ("rejected" as const);
      }
      yield* Effect.sleep(`${initialRetryDelayMillis * 2 ** (attempt - 1)} millis`);
      attempt += 1;
    }
    return "uncertain" as const;
  }
);
