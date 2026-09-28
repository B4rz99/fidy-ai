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
const OperatorEmailRequest = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
});

const operatorEmailBody = (
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

/** Sends only closed operator metadata over the existing bounded Resend transport. */
export const sendOperatorEmail = (
  input: Readonly<{
    alert: OperationalAlert;
    idempotencyKey: string;
    to: string;
    apiKey: string;
    release: string;
    phase: "firing" | "resolved";
    signal: AbortSignal;
  }>
): Promise<void> =>
  Effect.runPromiseExit(
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
        const body = yield* operatorEmailBody(input);
        return yield* outbound.execute({
          _tag: "ResendEmailDelivery",
          idempotencyKey: input.idempotencyKey,
          body,
        });
      })
    ),
    { signal: input.signal }
  ).then((result): void => {
    if (result._tag === "Failure") throw new Error("Operator email delivery unavailable");
    const response = result.value;
    if (
      response.status < successStatus ||
      response.status >= redirectStatus ||
      Result.isFailure(
        Schema.decodeResult(Schema.fromJsonString(ResendAccepted))(
          new TextDecoder().decode(response.body)
        )
      )
    ) {
      throw new Error("Operator email delivery unavailable");
    }
  });
