import { DaviplataOtpPolicy } from "../../../src/core/subscription/contract";
import { type WompiEnvironment } from "../../../src/shell/secret-material/contract";

import { makeWompiOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { Context, Crypto, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
} from "../../runtime/telemetry/operations";

export const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, new Uint8Array(bytes))
          .then((value) => new Uint8Array(value)),
      catch: () => undefined,
    }).pipe(Effect.orDie),
});

type WompiBindings = Readonly<{
  WOMPI_ENVIRONMENT: WompiEnvironment;
  WOMPI_PUBLIC_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_INTEGRITY_SECRET: string;
}> &
  Partial<
    Readonly<{
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
    }>
  >;

/** Construct the policy-bearing provider HTTP adapter from validated Worker bindings. */
export const wompiOutboundHttp = (
  environment: WompiBindings
): Effect.Effect<ReturnType<typeof makeWompiOutboundHttp>> =>
  Effect.scoped(
    Layer.build(FetchHttpClient.layer).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        observeProviderFetch(globalThis.fetch, {
          provider: "wompi",
          environment,
          telemetry: cloudflareWorkerTelemetry,
        })
      ),
      Effect.map((clients) =>
        makeWompiOutboundHttp({
          environment: environment.WOMPI_ENVIRONMENT,
          publicKey: environment.WOMPI_PUBLIC_KEY,
          privateKey: Redacted.make(environment.WOMPI_PRIVATE_KEY),
          integritySecret: Redacted.make(environment.WOMPI_INTEGRITY_SECRET),
          httpClient: Context.get(clients, HttpClient.HttpClient),
          crypto: workerCrypto,
          daviplataSandboxPolicy:
            environment.WOMPI_ENVIRONMENT === "sandbox"
              ? Schema.decodeUnknownOption(DaviplataOtpPolicy)({
                  sendUrl: environment.WOMPI_DAVIPLATA_OTP_SEND_URL,
                  confirmUrl: environment.WOMPI_DAVIPLATA_OTP_CONFIRM_URL,
                })
              : Option.none(),
        })
      )
    )
  );
