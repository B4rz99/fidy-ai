import { Config, Context, Crypto, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
  loadResendEmailDeliveryApiKey,
  loadResendReceivingApiKey,
  loadWompiIntegritySecret,
  loadWompiPrivateKey,
} from "~/shell/secret-material/operations";
import { makeOutboundHttp } from "~/shell/outbound-http/internal/outbound-http";
import type { OutboundHttpFailure, OutboundHttpRequest, OutboundHttpResponse } from "./contract";

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
      const kapsoApiKey = yield* Config.redacted("KAPSO_API_KEY");
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
        resendEmailDeliveryApiKey,
        resendReceivingApiKey,
        wompi: {
          environment: wompiEnvironment,
          publicKey: wompiPublicKey,
          privateKey: wompiPrivateKey,
          integritySecret: wompiIntegritySecret,
        },
        httpClient,
        crypto,
      });
    })
  );
}
