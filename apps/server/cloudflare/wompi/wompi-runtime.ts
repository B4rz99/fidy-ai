import { type WompiEnvironment, makeWompiOutboundHttp } from "@fidy/server/subscription-runtime";
import { Context, Crypto, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

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
}>;

/** Construct the policy-bearing provider HTTP adapter from validated Worker bindings. */
export const wompiOutboundHttp = (
  environment: WompiBindings
): Effect.Effect<ReturnType<typeof makeWompiOutboundHttp>> =>
  Effect.scoped(
    Layer.build(FetchHttpClient.layer).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.map((clients) =>
        makeWompiOutboundHttp({
          environment: environment.WOMPI_ENVIRONMENT,
          publicKey: environment.WOMPI_PUBLIC_KEY,
          privateKey: Redacted.make(environment.WOMPI_PRIVATE_KEY),
          integritySecret: Redacted.make(environment.WOMPI_INTEGRITY_SECRET),
          httpClient: Context.get(clients, HttpClient.HttpClient),
          crypto: workerCrypto,
        })
      )
    )
  );
