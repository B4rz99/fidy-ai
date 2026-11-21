import { OutboundHttpLive, installedProviderFetch } from "../../outbound-http/runtime";
import { Cause, Context, Effect, Exit, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import type {
  EmailAddress,
  EmailVerificationCode,
} from "../../../src/core/email-authentication/contract";
import {
  EmailDelivery,
  type EmailDeliveryPortService,
} from "../../../src/shell/email-authentication/runtime";
import { OutboundHttp } from "../../../src/shell/outbound-http/operations";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../../runtime/telemetry/operations";
import type { WorkerTraceContinuation } from "../../runtime/telemetry/contract";

export type ProviderCertainty = "accepted" | "rejected" | "ambiguous";

export const sendClaimedProof = (
  input: WorkerTraceContinuation &
    Readonly<{
      purpose: Parameters<EmailDeliveryPortService["send"]>[0]["purpose"];
      environment: Readonly<{ RESEND_API_KEY: string }>;
      to: EmailAddress;
      combinedCode: EmailVerificationCode;
      id: string;
    }>
): Promise<ProviderCertainty> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const fetcher = yield* installedProviderFetch({
          provider: "resend",
          environment: input.environment,
          telemetry: cloudflareWorkerTelemetry,
        });

        const services = yield* Layer.build(
          EmailDelivery.layer.pipe(
            Layer.provide(OutboundHttp.resend(Redacted.make(input.environment.RESEND_API_KEY))),
            Layer.provide(OutboundHttpLive)
          )
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetcher));

        return yield* Context.get(services, EmailDelivery).send({
          purpose: input.purpose,
          to: input.to,
          combinedCode: input.combinedCode,
          idempotencyKey: input.id,
        });
      })
    ).pipe(
      observeWorkerExecution({
        environment: workerRelease(input.environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "emailAuthentication.processPairingDelivery",
        parent: input.parent,
      })
    )
  ).then((outcome): ProviderCertainty => {
    if (Exit.isSuccess(outcome)) return "accepted";

    return outcome.cause.reasons.length > 0 &&
      outcome.cause.reasons.every(
        (reason) => Cause.isFailReason(reason) && reason.error.certainty === "rejected"
      )
      ? "rejected"
      : "ambiguous";
  });
