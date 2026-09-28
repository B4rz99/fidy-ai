import { makeResendOutboundHttp } from "../../src/shell/outbound-http/operations";
import { cloudflareWorkerTelemetry, observeProviderFetch } from "./telemetry";
import type { OperationalAlert } from "./operational-alerts";
import { Context, Effect, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

const maximumResendIdLength = 128;
const successStatus = 200;
const redirectStatus = 300;
const ResendAccepted = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumResendIdLength)),
});

/** Sends only closed operator metadata over the existing bounded Resend transport. */
export const sendOperatorEmail = async (
  input: Readonly<{
    alert: OperationalAlert;
    idempotencyKey: string;
    to: string;
    apiKey: string;
    release: string;
    signal: AbortSignal;
  }>
): Promise<void> => {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            observeProviderFetch(globalThis.fetch, {
              provider: "resend",
              environment: { RELEASE_GIT_SHA: input.release },
              telemetry: cloudflareWorkerTelemetry,
            })
          )
        );
        const outbound = makeResendOutboundHttp({
          apiKey: Redacted.make(input.apiKey),
          httpClient: Context.get(clients, HttpClient.HttpClient),
        });
        const text = `Fidy operational alert: ${input.alert.kind} / ${input.alert.owner} (${input.alert.severity}). Inspect private Cloudflare operational state. No work identity is included.`;
        return yield* outbound.execute({
          _tag: "ResendEmailDelivery",
          idempotencyKey: input.idempotencyKey,
          body: JSON.stringify({
            from: "Fidy <obarboza@fidyapp.com>",
            to: [input.to],
            subject: `Fidy: ${input.alert.severity} operational alert`,
            text,
          }),
        });
      })
    ),
    { signal: input.signal }
  );
  if (result._tag === "Failure") throw new Error("Operator email delivery unavailable");
  const response = result.value;
  if (
    response.status < successStatus ||
    response.status >= redirectStatus ||
    Result.isFailure(
      Schema.decodeUnknownResult(Schema.fromJsonString(ResendAccepted))(
        new TextDecoder().decode(response.body)
      )
    )
  ) {
    throw new Error("Operator email delivery unavailable");
  }
};
