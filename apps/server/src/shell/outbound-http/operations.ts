import { Config, Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import { acquireCloudflareAccessToken } from "~/shell/outbound-http/internal/cloudflare-access";
import {
  loadResendEmailDeliveryApiKey,
  loadResendReceivingApiKey,
  loadWompiIntegritySecret,
  loadWompiPrivateKey,
} from "~/shell/secret-material/operations";
import {
  makeCloudflareAccessOutboundHttp,
  makeOutboundHttp,
  makeSentryOutboundHttp,
} from "~/shell/outbound-http/internal/outbound-http";
import type {
  OutboundHttpFailure,
  OutboundHttpRequest,
  OutboundHttpResponse,
  OutboundHttpSetupError,
} from "./contract";

const WompiEnvironment = Schema.Literals(["sandbox", "production"]);
const WompiPublicKey = Schema.String.check(
  Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
);

/**
 * Executes a request through its closed provider destination policy. Callers provide no URL,
 * provider credential, headers, redirect choice, tracing choice, or byte limit and receive only
 * bounded response bytes, explicitly retained headers, or a coordinate-free failure.
 */
export type OutboundHttpService = Readonly<{
  readonly execute: (
    request: OutboundHttpRequest
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

/** Authority to reach an external provider through the published Outbound HTTP policy. */
export class OutboundHttp extends Context.Service<OutboundHttp, OutboundHttpService>()(
  "@fidy/server/shell/outbound-http/operations/OutboundHttp"
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const kapsoApiKey = yield* Config.Redacted("KAPSO_API_KEY").pipe(Config.option);
      const openAiApiKey = yield* Config.Redacted("OPENAI_API_KEY").pipe(Config.option);
      const openAiApiUrl = yield* Config.String("OPENAI_API_URL").pipe(
        Config.withDefault("https://api.openai.com/v1")
      );
      const mistralApiKey = yield* Config.Redacted("MISTRAL_API_KEY").pipe(Config.option);
      const resendEmailDeliveryApiKey = yield* loadResendEmailDeliveryApiKey;
      const resendReceivingApiKey = yield* loadResendReceivingApiKey;
      const wompiEnvironment = yield* Config.schema(WompiEnvironment, "WOMPI_ENVIRONMENT");
      const environmentPrefix = wompiEnvironment === "sandbox" ? "test" : "prod";
      const wompiPublicKey = yield* Config.schema(
        WompiPublicKey.check(Schema.isStartsWith(`pub_${environmentPrefix}_`)),
        "WOMPI_PUBLIC_KEY"
      );
      const wompiPrivateKey = yield* loadWompiPrivateKey(wompiEnvironment);
      const wompiIntegritySecret = yield* loadWompiIntegritySecret(wompiEnvironment);
      const httpClient = yield* HttpClient.HttpClient;
      const crypto = yield* Crypto.Crypto;
      return makeOutboundHttp({
        kapsoApiKey,
        openAiApiKey,
        openAiApiUrl,
        mistralApiKey,
        resendEmailDeliveryApiKey: Option.some(resendEmailDeliveryApiKey),
        resendReceivingApiKey: Option.some(resendReceivingApiKey),
        wompi: Option.some({
          environment: wompiEnvironment,
          publicKey: wompiPublicKey,
          privateKey: wompiPrivateKey,
          integritySecret: wompiIntegritySecret,
        }),
        httpClient,
        crypto: Option.some(crypto),
      });
    })
  );

  /** OpenAI-only construction for hosted inference and provider-library calls. */
  static readonly openAiLayer = Layer.effect(
    this,
    Effect.gen(function* () {
      const openAiApiKey = yield* Config.Redacted("OPENAI_API_KEY");
      const openAiApiUrl = yield* Config.String("OPENAI_API_URL").pipe(
        Config.withDefault("https://api.openai.com/v1")
      );
      const httpClient = yield* HttpClient.HttpClient;
      return makeOutboundHttp({
        kapsoApiKey: Option.none(),
        openAiApiKey: Option.some(openAiApiKey),
        openAiApiUrl,
        mistralApiKey: Option.none(),
        resendEmailDeliveryApiKey: Option.none(),
        resendReceivingApiKey: Option.none(),
        wompi: Option.none(),
        httpClient,
        crypto: Option.none(),
      });
    })
  );

  /** Mistral-only construction for the manual conformance workflow. */
  static readonly mistralLayer = Layer.effect(
    this,
    Effect.gen(function* () {
      const mistralApiKey = yield* Config.Redacted("MISTRAL_API_KEY");
      const httpClient = yield* HttpClient.HttpClient;
      return makeOutboundHttp({
        kapsoApiKey: Option.none(),
        openAiApiKey: Option.none(),
        openAiApiUrl: "https://api.openai.com/v1",
        mistralApiKey: Option.some(mistralApiKey),
        resendEmailDeliveryApiKey: Option.none(),
        resendReceivingApiKey: Option.none(),
        wompi: Option.none(),
        httpClient,
        crypto: Option.none(),
      });
    })
  );

  static readonly sentryLayer = Layer.effect(
    this,
    Effect.gen(function* () {
      const authToken = yield* Config.Redacted("SENTRY_AUTH_TOKEN");
      const httpClient = yield* HttpClient.HttpClient;
      return makeSentryOutboundHttp({ authToken, httpClient });
    })
  );

  static readonly cloudflareAccessLayer: Layer.Layer<
    OutboundHttp,
    OutboundHttpSetupError,
    HttpClient.HttpClient
  > = Layer.effect(
    this,
    Effect.gen(function* () {
      const accessToken = yield* acquireCloudflareAccessToken();
      const httpClient = yield* HttpClient.HttpClient;
      return makeCloudflareAccessOutboundHttp({ accessToken, httpClient });
    })
  );
}
