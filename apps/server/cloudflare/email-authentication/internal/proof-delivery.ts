import { OutboundHttpLive } from "../../outbound-http/runtime";
import { Cause, Context, Effect, Exit, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type {
  EmailAddress,
  EmailVerificationCode,
} from "../../../src/core/email-authentication/contract";
import {
  type EmailDeliveryPortService,
  makeEmailDelivery,
} from "../../../src/shell/email-authentication/runtime";
import { makeResendOutboundHttp } from "../../../src/shell/outbound-http/operations";
import {
  captureObservedProviderFetch,
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../../runtime/telemetry/operations";
import type { WorkerTraceContinuation } from "../../runtime/telemetry/contract";
import type { EmailDeliveryEnvironment } from "../contract";

export type ProviderCertainty = "accepted" | "rejected" | "ambiguous";

/**
 * Send one claimed mailbox proof using its retained idempotency identity. The caller must keep
 * mailbox and proof out of Workflow history and settle the returned certainty into owner state;
 * an ambiguous outcome never authorizes another send with a fresh proof.
 */
export const sendClaimedProof = (
  input: WorkerTraceContinuation &
    Readonly<{
      purpose: Parameters<EmailDeliveryPortService["send"]>[0]["purpose"];
      environment: Pick<EmailDeliveryEnvironment, "RESEND_API_KEY">;
      to: EmailAddress;
      combinedCode: EmailVerificationCode;
      id: string;
    }>
): Promise<ProviderCertainty> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(OutboundHttpLive).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            yield* captureObservedProviderFetch(globalThis.fetch, {
              provider: "resend",
              environment: input.environment,
              telemetry: cloudflareWorkerTelemetry,
            })
          )
        );
        return yield* makeEmailDelivery({
          outboundHttp: makeResendOutboundHttp({
            apiKey: Redacted.make(input.environment.RESEND_API_KEY),
            httpClient: Context.get(clients, HttpClient.HttpClient),
          }),
        }).send({
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
