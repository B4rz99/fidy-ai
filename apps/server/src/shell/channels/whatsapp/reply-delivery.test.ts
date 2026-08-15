import { expect, it } from "@effect/vitest";
import { Duration, Option } from "effect";
import { TelemetryAttempt, TelemetryHttpStatus } from "~/shell/observability/protocol";
import { AgentReplyNotRenderable } from "./outbound";
import { KapsoSendFailed } from "./kapso-client";
import { DeliveryAttemptLimit, classifyDeliveryFailure } from "./reply-delivery";

const policy = {
  maximumAttempts: DeliveryAttemptLimit.make(3),
  rejectedRetryDelay: Duration.seconds(1),
};

it("retries only definitive automatic provider rejection while attempts remain", () => {
  const retryable = new KapsoSendFailed({
    safeReason: "rate_limited",
    deliveryCertainty: "rejected",
    automaticRetry: true,
    responseStatus: Option.some(TelemetryHttpStatus.make(429)),
  });

  expect(
    classifyDeliveryFailure({
      failure: retryable,
      attempt: TelemetryAttempt.make(1),
      policy,
    })
  ).toEqual({ _tag: "RetryRejected", delay: Duration.seconds(1) });
  expect(
    classifyDeliveryFailure({
      failure: retryable,
      attempt: TelemetryAttempt.make(3),
      policy,
    })
  ).toEqual({ _tag: "Stop" });

  expect(
    classifyDeliveryFailure({
      failure: new KapsoSendFailed({
        safeReason: "timeout",
        deliveryCertainty: "ambiguous",
        automaticRetry: false,
        responseStatus: Option.none(),
      }),
      attempt: TelemetryAttempt.make(1),
      policy,
    })
  ).toEqual({ _tag: "Stop" });
  expect(
    classifyDeliveryFailure({
      failure: new AgentReplyNotRenderable(),
      attempt: TelemetryAttempt.make(1),
      policy,
    })
  ).toEqual({ _tag: "Stop" });
});
