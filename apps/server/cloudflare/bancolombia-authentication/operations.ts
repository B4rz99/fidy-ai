import { revokeGrant, verifyTokenLifecycle } from "./internal/token-lifecycle";
import { activate } from "./internal/activation";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { Clock, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { SignJWT, importJWK, importPKCS8, jwtVerify } from "jose";
import { makeBancolombiaSandboxOutboundHttp } from "../../src/shell/outbound-http/operations";
import {
  type BancolombiaActivationInput,
  BancolombiaAuthenticationFailed,
  BancolombiaAuthorizationFailed,
  BancolombiaAuthorizationInput,
  type BancolombiaBankGrant,
  type BancolombiaCleanupProof,
  BancolombiaConsentProfile,
  type SandboxAuthenticationInput,
} from "./contract";

const maximumTokenBytes = 32768;
const millisecondsPerSecond = 1000;
const assertionLifetimeSeconds = 300;
const maximumApplicationTokenSeconds = 86400;
const successStatus = 200;
const parCreatedStatus = 201;
const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const Discovery = Schema.Struct({
  issuer: Schema.Literal(issuer),
  token_endpoint: Schema.Literal(token),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.String).check(
    Schema.makeFilter((values) => values.includes("private_key_jwt"))
  ),
  token_endpoint_auth_signing_alg_values_supported: Schema.Array(Schema.String).check(
    Schema.makeFilter((values) => values.includes("RS256"))
  ),
  tls_client_certificate_bound_access_tokens: Schema.Literal(true),
  mtls_endpoint_aliases: Schema.Struct({ token_endpoint: Schema.Literal(token) }),
});
const TokenLifecycleDiscovery = Schema.Struct({
  ...Discovery.fields,
  revocation_endpoint: Schema.Literal(`${token}/revoke`),
  introspection_endpoint: Schema.Literal(
    "https://as1-api-open-finance-sandbox.ambientesbc.com/introspection"
  ),
  mtls_endpoint_aliases: Schema.Struct({
    token_endpoint: Schema.Literal(token),
    revocation_endpoint: Schema.Literal(`${token}/revoke`),
    introspection_endpoint: Schema.Literal(
      "https://as1-api-open-finance-sandbox.ambientesbc.com/introspection"
    ),
  }),
});
const Token = Schema.Struct({
  access_token: Schema.String.check(Schema.isBetweenLength(1, maximumTokenBytes)),
  token_type: Schema.String.check(Schema.isPattern(/^Bearer$/iu)),
  expires_in: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maximumApplicationTokenSeconds })
  ),
  scope: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((value) => value.split(" ").includes("accounts")))
  ),
});
const failure = (
  stage: BancolombiaAuthenticationFailed["stage"]
): BancolombiaAuthenticationFailed => new BancolombiaAuthenticationFailed({ stage });

const prepareAssertion = Effect.fn(function* (input: SandboxAuthenticationInput) {
  if (
    !Schema.is(Schema.String.check(Schema.isUUID()))(input.clientId) ||
    input.publicKey.alg !== "RS256" ||
    input.publicKey.kid === undefined
  ) {
    return yield* failure("bancolombia_configuration");
  }
  const milliseconds = yield* Clock.currentTimeMillis;
  const now = Math.floor(milliseconds / millisecondsPerSecond);
  const jti = yield* input.crypto
    .randomUUIDv4()
    .pipe(Effect.mapError(() => failure("bancolombia_signing")));
  const privateKey = yield* Effect.tryPromise({
    try: () => importPKCS8(Redacted.value(input.privateKey), "RS256", { extractable: false }),
    catch: () => failure("bancolombia_signing"),
  });
  const jwt = yield* Effect.tryPromise({
    try: () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: input.publicKey.kid })
        .setIssuer(input.clientId)
        .setSubject(input.clientId)
        .setAudience(issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + assertionLifetimeSeconds)
        .setJti(jti)
        .sign(privateKey),
    catch: () => failure("bancolombia_signing"),
  });
  const publicKey = yield* Effect.tryPromise({
    try: () => importJWK(input.publicKey, "RS256"),
    catch: () => failure("bancolombia_signing"),
  });
  yield* Effect.tryPromise({
    try: () =>
      jwtVerify(jwt, publicKey, {
        algorithms: ["RS256"],
        issuer: input.clientId,
        subject: input.clientId,
        audience: issuer,
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(milliseconds)),
      }),
    catch: () => failure("bancolombia_signing"),
  });
  return Redacted.make(jwt);
});

/**
 * Verifies the configured key against registration before HTTP, then requests only an accounts
 * application token for the private consent request. No retry, User consent or account read occurs.
 */
const applicationToken = (
  input: SandboxAuthenticationInput,
  schema: typeof Discovery | typeof AuthorizationDiscovery | typeof TokenLifecycleDiscovery
): Effect.Effect<
  Readonly<{ bearer: Redacted.Redacted<string>; expiresAtMilliseconds: number }>,
  BancolombiaAuthenticationFailed
> =>
  Effect.gen(function* () {
    const assertion = yield* prepareAssertion(input);
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const discovery = yield* http
      .execute({ _tag: "Discovery" })
      .pipe(Effect.mapError(() => failure("bancolombia_discovery")));
    if (discovery.status !== successStatus) return yield* failure("bancolombia_discovery");
    yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      new TextDecoder().decode(discovery.body)
    ).pipe(Effect.mapError(() => failure("bancolombia_discovery")));
    const issuedAt = yield* Clock.currentTimeMillis;
    const response = yield* http
      .execute({ _tag: "Authenticate", assertion })
      .pipe(Effect.mapError(() => failure("bancolombia_authentication")));
    if (response.status !== successStatus) return yield* failure("bancolombia_authentication");
    const accepted = yield* Schema.decodeEffect(Schema.fromJsonString(Token))(
      new TextDecoder().decode(response.body)
    ).pipe(Effect.mapError(() => failure("bancolombia_authentication")));
    return {
      bearer: Redacted.make(accepted.access_token),
      expiresAtMilliseconds: issuedAt + accepted.expires_in * millisecondsPerSecond,
    };
  });

export const authenticateBancolombiaSandbox = (
  input: SandboxAuthenticationInput
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  applicationToken(input, Discovery).pipe(Effect.asVoid);

const authorizationEndpoint = `${issuer}/auth`;
const parEndpoint = "https://as1-api-open-finance-sandbox.ambientesbc.com/par";
const maximumParLifetimeSeconds = 600;
const AuthorizationDiscovery = Schema.Struct({
  ...Discovery.fields,
  authorization_endpoint: Schema.Literal(authorizationEndpoint),
  pushed_authorization_request_endpoint: Schema.Literal(parEndpoint),
  code_challenge_methods_supported: Schema.Array(Schema.String).check(
    Schema.makeFilter((values) => values.includes("S256"))
  ),
  mtls_endpoint_aliases: Schema.Struct({
    token_endpoint: Schema.Literal(token),
    pushed_authorization_request_endpoint: Schema.Literal(parEndpoint),
  }),
});
const PushedAuthorization = Schema.Struct({
  request_uri: Schema.String.check(
    Schema.isPattern(/^urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{1,256}$/u)
  ),
  expires_in: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maximumParLifetimeSeconds })
  ),
});

/** Push one already-created consent under the support-provided sandbox PAR contract; never create consent or retry uncertainty. */
export const pushBancolombiaSandboxAuthorization = (
  input: SandboxAuthenticationInput & BancolombiaAuthorizationInput
): Effect.Effect<
  Readonly<{ url: string; expiresAtMilliseconds: number }>,
  BancolombiaAuthorizationFailed
> =>
  Effect.gen(function* () {
    const parameters = yield* Schema.decodeEffect(BancolombiaAuthorizationInput)(input);
    const startedAt = yield* Clock.currentTimeMillis;
    if (parameters.expiresAtMilliseconds <= startedAt) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const assertion = yield* prepareAssertion(input);
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const discovery = yield* http.execute({ _tag: "Discovery" });
    if (discovery.status !== successStatus) return yield* new BancolombiaAuthorizationFailed();
    yield* Schema.decodeEffect(Schema.fromJsonString(AuthorizationDiscovery))(
      new TextDecoder().decode(discovery.body)
    );
    if (parameters.expiresAtMilliseconds <= (yield* Clock.currentTimeMillis)) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const pushedAt = yield* Clock.currentTimeMillis;
    const response = yield* http.execute({
      _tag: "PushAuthorization",
      assertion,
      clientId: input.clientId,
      ...parameters,
    });
    if (response.status !== parCreatedStatus) return yield* new BancolombiaAuthorizationFailed();
    const pushed = yield* Schema.decodeEffect(Schema.fromJsonString(PushedAuthorization))(
      new TextDecoder().decode(response.body)
    );
    const expiresAtMilliseconds = Math.min(
      parameters.expiresAtMilliseconds,
      pushedAt + pushed.expires_in * millisecondsPerSecond
    );
    if (expiresAtMilliseconds <= (yield* Clock.currentTimeMillis)) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: input.clientId,
      response_type: "code",
      scope: "accounts",
      request_uri: pushed.request_uri,
    }).toString();
    return { url: url.href, expiresAtMilliseconds };
  }).pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed()));

const ConsentRequest = Schema.Struct({
  Data: Schema.Struct({
    Permissions: Schema.Array(Schema.String),
    AccountOwner: BancolombiaConsentProfile.fields.accountOwner,
  }),
});
const AuthorizationProof = Schema.Struct({
  state: BancolombiaAuthorizationInput.fields.state,
  challenge: BancolombiaAuthorizationInput.fields.challenge,
  expiresAtMilliseconds: BancolombiaAuthorizationInput.fields.expiresAtMilliseconds,
});
const CreatedConsent = Schema.Struct({
  Data: Schema.Struct({
    ConsentId: BancolombiaAuthorizationInput.fields.consentId,
    Status: Schema.optionalKey(Schema.Literal("AwaitingAuthorization")),
    Permissions: Schema.optionalKey(Schema.Array(Schema.String)),
    ExpirationDateTime: Schema.optionalKey(UtcTimestamp),
  }),
});
type ConsentCreationInput = SandboxAuthenticationInput &
  Omit<BancolombiaAuthorizationInput, "consentId"> &
  Readonly<{
    profile: Redacted.Redacted<BancolombiaConsentProfile>;
    recordConsent: (consentId: string) => Effect.Effect<void, BancolombiaAuthorizationFailed>;
  }>;
const matchesPermissions = (
  created: (typeof CreatedConsent.Type)["Data"],
  requested: readonly string[]
): boolean =>
  created.Permissions === undefined ||
  (created.Permissions.length === requested.length &&
    new Set(created.Permissions).size === requested.length &&
    created.Permissions.every((permission) => requested.includes(permission)));
const createConsent = (
  input: ConsentCreationInput
): Effect.Effect<
  Readonly<{ consentId: string; expiresAtMilliseconds: number }>,
  BancolombiaAuthorizationFailed
> =>
  Effect.gen(function* () {
    const profile = Redacted.value(input.profile);
    const { bearer } = yield* applicationToken(input, AuthorizationDiscovery);
    if (input.expiresAtMilliseconds <= (yield* Clock.currentTimeMillis)) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const interactionId = yield* input.crypto.randomUUIDv4();
    const payload = yield* Schema.encodeEffect(Schema.fromJsonString(ConsentRequest))({
      Data: {
        Permissions: profile.intent.permissions,
        AccountOwner: profile.accountOwner,
      },
    });
    const response = yield* makeBancolombiaSandboxOutboundHttp(input.httpClient).execute({
      _tag: "CreateConsent",
      bearer,
      financialId: profile.financialId,
      interactionId,
      customerIpAddress: Option.fromUndefinedOr(profile.customerIpAddress),
      payload: Redacted.make(payload),
    });
    if (![successStatus, parCreatedStatus].includes(response.status)) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const created = (yield* Schema.decodeEffect(Schema.fromJsonString(CreatedConsent))(
      new TextDecoder().decode(response.body)
    )).Data;
    if (!matchesPermissions(created, profile.intent.permissions)) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    yield* input.recordConsent(created.ConsentId);
    return {
      consentId: created.ConsentId,
      expiresAtMilliseconds: Math.min(
        input.expiresAtMilliseconds,
        created.ExpirationDateTime?.epochMilliseconds ?? input.expiresAtMilliseconds
      ),
    };
  }).pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed()));

/** Create the support-collection consent once, record its identifier, then push the exact PAR. */
export const authorizeBancolombiaSandbox = (
  input: ConsentCreationInput
): Effect.Effect<
  Readonly<{ url: string; expiresAtMilliseconds: number }>,
  BancolombiaAuthorizationFailed
> =>
  Effect.gen(function* () {
    yield* Schema.decodeEffect(AuthorizationProof)(input);
    yield* Schema.decodeEffect(Schema.toType(BancolombiaConsentProfile))(
      Redacted.value(input.profile)
    );
    const now = yield* Clock.currentTimeMillis;
    if (input.expiresAtMilliseconds <= now) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const created = yield* createConsent(input);
    return yield* pushBancolombiaSandboxAuthorization({ ...input, ...created });
  }).pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed()));

export const activateBancolombiaSandbox = (
  input: SandboxAuthenticationInput & BancolombiaActivationInput
): Effect.Effect<ReadonlyArray<string>, BancolombiaAuthorizationFailed> =>
  activate({
    ...input,
    assertion: prepareAssertion(input),
    retainGrant: (grant) =>
      input
        .retainGrant(grant)
        .pipe(
          Effect.onError(() =>
            revokeBancolombiaSandboxGrant({ ...input, grant, proof: Option.none() }).pipe(
              Effect.orElseSucceed(() => undefined)
            )
          )
        ),
    consentBearer: applicationToken(input, Discovery).pipe(Effect.map((grant) => grant.bearer)),
  });

/** Verifies active-to-inactive application-token behavior; grants no customer authority or consent cleanup guarantee. */
export const verifyBancolombiaSandboxTokenLifecycle = (
  input: SandboxAuthenticationInput
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const grant = yield* applicationToken(input, TokenLifecycleDiscovery);
    yield* verifyTokenLifecycle({
      ...input,
      ...grant,
      assertion: prepareAssertion(input),
    });
  }).pipe(
    Effect.timeout("60 seconds"),
    Effect.mapError(() => failure("bancolombia_token_lifecycle"))
  );

/** Revoke only the supplied held grant and verify both token kinds inactive; does not cancel bank consent. */
export const revokeBancolombiaSandboxGrant = (
  input: SandboxAuthenticationInput &
    Readonly<{ grant: BancolombiaBankGrant; proof: Option.Option<BancolombiaCleanupProof> }>
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    const response = yield* makeBancolombiaSandboxOutboundHttp(input.httpClient).execute({
      _tag: "Discovery",
    });
    if (response.status !== successStatus) return yield* failure("bancolombia_discovery");
    yield* Schema.decodeEffect(Schema.fromJsonString(TokenLifecycleDiscovery))(
      new TextDecoder().decode(response.body)
    );
    yield* revokeGrant({
      ...input,
      proof: Option.getOrElse(input.proof, (): BancolombiaCleanupProof => ({
        observedTokens: [],
        recordActive: () => Effect.void,
      })),
      assertion: prepareAssertion(input),
    });
  }).pipe(
    Effect.timeout("60 seconds"),
    Effect.mapError(() => new BancolombiaAuthorizationFailed())
  );
