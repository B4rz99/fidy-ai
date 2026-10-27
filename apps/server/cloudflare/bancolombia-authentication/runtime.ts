import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankActivation,
  type ConnectionBankPreparation,
} from "../connections/contract";
import {
  Clock,
  Context,
  Crypto,
  Effect,
  Layer,
  Option,
  PlatformError,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { sandboxPublicKey } from "../bancolombia-sandbox/contract";
import {
  BancolombiaAuthenticationFailed,
  BancolombiaAuthorizationFailed,
  BancolombiaConsentProfile,
  type BancolombiaSandboxEnvironment,
} from "./contract";
import {
  activateBancolombiaSandbox,
  authenticateBancolombiaSandbox,
  authorizeBancolombiaSandbox,
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

const sandboxProfile = (
  environment: BancolombiaSandboxEnvironment
): Option.Option<BancolombiaConsentProfile> =>
  Option.flatMap(
    Option.fromUndefinedOr(environment.BANCOLOMBIA_SANDBOX_CONSENT_PROFILE).pipe(
      Option.filter((value) => value.length <= maximumProfileLength)
    ),
    Schema.decodeUnknownOption(Schema.fromJsonString(BancolombiaConsentProfile))
  );

export const bancolombiaSandboxAdmission = (
  environment: BancolombiaSandboxEnvironment
): Option.Option<Readonly<{ userId: string; startsAt: number; expiresAt: number }>> =>
  Option.map(sandboxProfile(environment), ({ userId, admission }) => ({
    userId,
    startsAt: admission.startsAt.epochMilliseconds,
    expiresAt: admission.expiresAt.epochMilliseconds,
  }));

const prepareProfile = (
  environment: BancolombiaSandboxEnvironment,
  profile: BancolombiaConsentProfile,
  request: Parameters<ConnectionBankPreparation["prepare"]>[0]
): ReturnType<ConnectionBankPreparation["prepare"]> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (
      request.userId !== profile.userId ||
      now < profile.admission.startsAt.epochMilliseconds ||
      now >= profile.admission.expiresAt.epochMilliseconds
    ) {
      return yield* new ConnectionAuthorizationUnavailable();
    }
    return yield* withSandboxClient(environment, (client) =>
      authorizeBancolombiaSandbox({
        ...client,
        ...request,
        expiresAtMilliseconds: Math.min(
          request.expiresAtMilliseconds,
          profile.admission.expiresAt.epochMilliseconds
        ),
        profile: Redacted.make(profile),
        recordConsent: (consentId) =>
          request
            .recordConsent(consentId)
            .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
      })
    ).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));
  });

/** Missing or foreign test profiles cannot install bank execution; registration remains a separate gate. */
export const makeBancolombiaSandboxPreparation = (
  input: Readonly<{ environment: BancolombiaSandboxEnvironment; userId: string }>
): Option.Option<ConnectionBankPreparation> =>
  Option.filter(
    sandboxProfile(input.environment),
    (profile) => profile.userId === input.userId
  ).pipe(
    Option.map((profile) => ({
      intent: profile.intent,
      prepare: (request) => prepareProfile(input.environment, profile, request),
    }))
  );

const activateProfile = (
  environment: BancolombiaSandboxEnvironment,
  profile: BancolombiaConsentProfile,
  request: Parameters<ConnectionBankActivation["activate"]>[0]
): ReturnType<ConnectionBankActivation["activate"]> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (
      request.userId !== profile.userId ||
      now < profile.admission.startsAt.epochMilliseconds ||
      now >= profile.admission.expiresAt.epochMilliseconds
    ) {
      return yield* new ConnectionAuthorizationUnavailable();
    }
    return yield* withSandboxClient(environment, (client) =>
      activateBancolombiaSandbox({
        ...client,
        ...request,
        expiresAtMilliseconds: Math.min(
          request.expiresAtMilliseconds,
          profile.admission.expiresAt.epochMilliseconds
        ),
        retainGrant: (grant) =>
          request
            .retainGrant(grant)
            .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
      })
    );
  }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));

export const makeBancolombiaSandboxActivation = (
  input: Readonly<{ environment: BancolombiaSandboxEnvironment; userId: string }>
): Option.Option<ConnectionBankActivation> =>
  Option.filter(
    sandboxProfile(input.environment),
    (profile) => profile.userId === input.userId
  ).pipe(
    Option.map((profile) => ({
      clientId: input.environment.BANCOLOMBIA_SANDBOX_CLIENT_ID ?? "",
      activate: (request) => activateProfile(input.environment, profile, request),
    }))
  );
