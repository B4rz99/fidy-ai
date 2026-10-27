import { UtcTimestamp } from "../../src/core/_shared/time";
import { Clock, type Crypto, DateTime, Effect, Option, Redacted, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { type JWK, SignJWT, importJWK, importPKCS8, jwtVerify } from "jose";
import { makeBancolombiaSandboxOutboundHttp } from "../../src/shell/outbound-http/operations";
import {
  BancolombiaAuthenticationFailed,
  BancolombiaAuthorizationFailed,
  BancolombiaAuthorizationInput,
  BancolombiaConsentProfile,
} from "./contract";

const maximumTokenBytes = 32768;
const millisecondsPerSecond = 1000;
const assertionLifetimeSeconds = 300;
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
const Token = Schema.Struct({
  access_token: Schema.String.check(Schema.isBetweenLength(1, maximumTokenBytes)),
  token_type: Schema.String.check(Schema.isPattern(/^Bearer$/iu)),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((value) => value.split(" ").includes("accounts")))
  ),
});
const failure = (
  stage: BancolombiaAuthenticationFailed["stage"]
): BancolombiaAuthenticationFailed => new BancolombiaAuthenticationFailed({ stage });

type SandboxAuthenticationInput = Readonly<{
  crypto: Crypto.Crypto;
  clientId: string;
  privateKey: Redacted.Redacted<string>;
  publicKey: JWK;
  httpClient: HttpClient.HttpClient;
}>;

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
 * application token. No retry, User consent or account read occurs; the bearer never leaves this call.
 */
const applicationToken = (
  input: SandboxAuthenticationInput,
  schema: typeof Discovery | typeof AuthorizationDiscovery
): Effect.Effect<Redacted.Redacted<string>, BancolombiaAuthenticationFailed> =>
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
    const response = yield* http
      .execute({ _tag: "Authenticate", assertion })
      .pipe(Effect.mapError(() => failure("bancolombia_authentication")));
    if (response.status !== successStatus) return yield* failure("bancolombia_authentication");
    const accepted = yield* Schema.decodeEffect(Schema.fromJsonString(Token))(
      new TextDecoder().decode(response.body)
    ).pipe(Effect.mapError(() => failure("bancolombia_authentication")));
    return Redacted.make(accepted.access_token);
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
    TransactionFromDateTime: UtcTimestamp,
    TransactionToDateTime: UtcTimestamp,
    AccountOwner: BancolombiaConsentProfile.fields.accountOwner,
    OnBehalfOf: BancolombiaConsentProfile.fields.onBehalfOf,
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
    TransactionFromDateTime: Schema.optionalKey(UtcTimestamp),
    TransactionToDateTime: Schema.optionalKey(UtcTimestamp),
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
const matchesHistory = (
  created: (typeof CreatedConsent.Type)["Data"],
  requested: BancolombiaConsentProfile["intent"]
): boolean =>
  (created.TransactionFromDateTime === undefined ||
    created.TransactionFromDateTime.epochMilliseconds ===
      requested.historyFrom.epochMilliseconds) &&
  (created.TransactionToDateTime === undefined ||
    created.TransactionToDateTime.epochMilliseconds === requested.historyTo.epochMilliseconds);

const createConsent = (
  input: ConsentCreationInput
): Effect.Effect<
  Readonly<{ consentId: string; expiresAtMilliseconds: number }>,
  BancolombiaAuthorizationFailed
> =>
  Effect.gen(function* () {
    const profile = Redacted.value(input.profile);
    const bearer = yield* applicationToken(input, AuthorizationDiscovery);
    if (input.expiresAtMilliseconds <= (yield* Clock.currentTimeMillis)) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const interactionId = yield* input.crypto.randomUUIDv4();
    const payload = yield* Schema.encodeEffect(Schema.fromJsonString(ConsentRequest))({
      Data: {
        Permissions: profile.intent.permissions,
        TransactionFromDateTime: profile.intent.historyFrom,
        TransactionToDateTime: profile.intent.historyTo,
        AccountOwner: profile.accountOwner,
        ...(profile.onBehalfOf === undefined ? {} : { OnBehalfOf: profile.onBehalfOf }),
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
    if (
      !matchesPermissions(created, profile.intent.permissions) ||
      !matchesHistory(created, profile.intent)
    ) {
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
    const profile = yield* Schema.decodeEffect(Schema.toType(BancolombiaConsentProfile))(
      Redacted.value(input.profile)
    );
    const now = yield* Clock.currentTimeMillis;
    if (input.expiresAtMilliseconds <= now || profile.intent.historyTo.epochMilliseconds > now) {
      return yield* new BancolombiaAuthorizationFailed();
    }
    const created = yield* createConsent(input);
    return yield* pushBancolombiaSandboxAuthorization({ ...input, ...created });
  }).pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed()));
