import { makeResendOutboundHttp } from "../../../../src/shell/outbound-http/operations";
import { cloudflareWorkerTelemetry, observeProviderFetch } from "../../telemetry/operations";
import type { OperationalAlert } from "../contract";
import { Context, Effect, Layer, Redacted, Schema, type Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const maximumResendIdLength = 128;
export const successStatus = 200;
export const redirectStatus = 300;
export const ResendAccepted = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumResendIdLength)),
});
const OperatorEmailRequest = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
});

export const operatorEmailBody = (
  input: Readonly<{
    alert: OperationalAlert;
    phase: "firing" | "resolved";
    to: string;
  }>
): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(Schema.fromJsonString(OperatorEmailRequest))({
    from: "Fidy <obarboza@fidyapp.com>",
    to: [input.to],
    subject:
      input.phase === "resolved"
        ? "Fidy: operational alert resolved"
        : `Fidy: ${input.alert.severity} operational alert`,
    text: `Fidy operational alert ${input.phase}: ${input.alert.kind} / ${input.alert.owner} (${input.alert.severity}). Inspect private Cloudflare operational state. No work identity is included.`,
  });

export const makeOperatorEmailClient = (
  input: Readonly<{ apiKey: string; release: string }>
): Effect.Effect<ReturnType<typeof makeResendOutboundHttp>, never, Scope.Scope> =>
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
    return makeResendOutboundHttp({
      apiKey: Redacted.make(input.apiKey),
      httpClient: Context.get(clients, HttpClient.HttpClient),
    });
  });
