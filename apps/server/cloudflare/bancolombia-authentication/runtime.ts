import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankPreparation,
} from "../connections/contract";
import { Context, Crypto, Effect, Layer, Option, PlatformError, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { sandboxPublicKey } from "../bancolombia-sandbox/contract";
import {
  BancolombiaAuthenticationFailed,
  BancolombiaAuthorizationFailed,
  type BancolombiaAuthorizationInput,
  BancolombiaConsentProfile,
  type BancolombiaSandboxEnvironment,
} from "./contract";
import {
  authenticateBancolombiaSandbox,
  authorizeBancolombiaSandbox,
  pushBancolombiaSandboxAuthorization,
} from "./operations";

const maximumPrivateKeyLength = 20000;
const maximumProfileLength = 8192;
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

const withSandboxClient = <A, E>(
  environment: BancolombiaSandboxEnvironment,
  run: (input: Parameters<typeof authenticateBancolombiaSandbox>[0]) => Effect.Effect<A, E>
): Effect.Effect<A, E | BancolombiaAuthenticationFailed> =>
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
    return yield* run({
      crypto: workerCrypto,
      clientId,
      privateKey: Redacted.make(key),
      publicKey: sandboxPublicKey,
      httpClient: Context.get(services, HttpClient.HttpClient),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  }).pipe(Effect.scoped);

/** Use only the private Core certificate binding and registered signing key; missing bindings refuse. */
export const verifyBancolombiaSandboxAuthentication = (
  environment: BancolombiaSandboxEnvironment
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  withSandboxClient(environment, authenticateBancolombiaSandbox);

/** Caller must have durably admitted this exact attempt and consent; no request or retry authority is created here. */
export const prepareBancolombiaSandboxAuthorization = ({
  environment,
  request,
}: Readonly<{
  environment: BancolombiaSandboxEnvironment;
  request: BancolombiaAuthorizationInput;
}>): Effect.Effect<
  Readonly<{ url: string; expiresAtMilliseconds: number }>,
  BancolombiaAuthorizationFailed
> =>
  withSandboxClient(environment, (input) =>
    pushBancolombiaSandboxAuthorization({ ...input, ...request })
  ).pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed()));

/** Missing or foreign test profiles cannot install bank execution; registration remains a separate gate. */
export const makeBancolombiaSandboxPreparation = (
  input: Readonly<{ environment: BancolombiaSandboxEnvironment; userId: string }>
): Option.Option<ConnectionBankPreparation> => {
  const parsed = Option.flatMap(
    Option.fromUndefinedOr(input.environment.BANCOLOMBIA_SANDBOX_CONSENT_PROFILE).pipe(
      Option.filter((value) => value.length <= maximumProfileLength)
    ),
    Schema.decodeUnknownOption(Schema.fromJsonString(BancolombiaConsentProfile))
  );
  return Option.filter(parsed, (profile) => profile.userId === input.userId).pipe(
    Option.map((profile) => {
      const redactedProfile = Redacted.make(profile);
      return {
        intent: profile.intent,
        prepare: (request) =>
          withSandboxClient(input.environment, (client) =>
            authorizeBancolombiaSandbox({
              ...client,
              ...request,
              profile: redactedProfile,
              recordConsent: (consentId) =>
                request
                  .recordConsent(consentId)
                  .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
            })
          ).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable())),
      };
    })
  );
};
