import { Cause, Context, Effect, Exit, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type {
  EmailAddress,
  EmailVerificationCode,
} from "../../../src/core/email-authentication/contract";
import {
  type EmailDeliveryPortService,
  type EmailSendFailed,
  makeEmailDelivery,
} from "../../../src/shell/email-authentication/runtime";
import { makeResendOutboundHttp } from "../../../src/shell/outbound-http/operations";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
} from "../../runtime/telemetry/operations";
import type { EmailDeliveryEnvironment } from "../contract";

/**
 * Send one claimed mailbox proof using its retained idempotency identity. The caller must keep
 * mailbox and proof out of Workflow history and settle the returned certainty into owner state;
 * an ambiguous outcome never authorizes another send with a fresh proof.
 */
export const sendThroughResend = (
  input: Readonly<{
    purpose: Parameters<EmailDeliveryPortService["send"]>[0]["purpose"];
    environment: Pick<EmailDeliveryEnvironment, "RESEND_API_KEY">;
    to: EmailAddress;
    combinedCode: EmailVerificationCode;
    id: string;
  }>
): Promise<Exit.Exit<void, EmailSendFailed>> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            observeProviderFetch(globalThis.fetch, {
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
    )
  );

export const deliveryState = (
  outcome: Exit.Exit<void, EmailSendFailed>
): "awaiting_proof" | "rejected" | "ambiguous" => {
  if (Exit.isSuccess(outcome)) return "awaiting_proof";
  const failure = Cause.findErrorOption(outcome.cause);
  return Option.isSome(failure) && failure.value.certainty === "rejected"
    ? "rejected"
    : "ambiguous";
};
