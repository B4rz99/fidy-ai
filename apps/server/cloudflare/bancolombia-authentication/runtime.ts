import { Context, Crypto, Effect, Layer, PlatformError, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { sandboxPublicKey } from "../bancolombia-sandbox/contract";
import { BancolombiaAuthenticationFailed, type BancolombiaSandboxEnvironment } from "./contract";
import { authenticateBancolombiaSandbox } from "./operations";

const maximumPrivateKeyLength = 20000;
const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((bytes) => new Uint8Array(bytes)),
      catch: () =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "BancolombiaCrypto",
          method: "digest",
        }),
    }),
});

/** Use only the private Core certificate binding and registered signing key; missing bindings refuse. */
export const verifyBancolombiaSandboxAuthentication = (
  environment: BancolombiaSandboxEnvironment
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const binding = environment.BANCOLOMBIA_SANDBOX_MTLS;
    const clientId = environment.BANCOLOMBIA_SANDBOX_CLIENT_ID;
    const key = environment.BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM;
    if (
      binding === undefined ||
      clientId === undefined ||
      key === undefined ||
      key.length === 0 ||
      key.length > maximumPrivateKeyLength ||
      !Schema.is(Schema.String.check(Schema.isUUID()))(clientId)
    ) {
      return yield* new BancolombiaAuthenticationFailed({ stage: "bancolombia_configuration" });
    }
    const fetch: typeof globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => binding.fetch(input, init),
      { preconnect: globalThis.fetch.preconnect }
    );
    const services = yield* Layer.build(OutboundHttpLive).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch)
    );
    return yield* authenticateBancolombiaSandbox({
      crypto: workerCrypto,
      clientId,
      privateKey: Redacted.make(key),
      publicKey: sandboxPublicKey,
      httpClient: Context.get(services, HttpClient.HttpClient),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  }).pipe(Effect.scoped);
