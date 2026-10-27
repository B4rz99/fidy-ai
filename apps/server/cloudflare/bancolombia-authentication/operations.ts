import { Clock, type Crypto, DateTime, Effect, Redacted, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { type JWK, SignJWT, importJWK, importPKCS8, jwtVerify } from "jose";
import { makeBancolombiaSandboxOutboundHttp } from "../../src/shell/outbound-http/operations";
import { BancolombiaAuthenticationFailed } from "./contract";

const maximumTokenBytes = 32768;
const millisecondsPerSecond = 1000;
const assertionLifetimeSeconds = 300;
const successStatus = 200;
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
export const authenticateBancolombiaSandbox = (
  input: SandboxAuthenticationInput
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    if (
      !Schema.is(Schema.String.check(Schema.isUUID()))(input.clientId) ||
      input.publicKey.alg !== "RS256" ||
      input.publicKey.kid === undefined
    ) {
      return yield* failure("bancolombia_configuration");
    }
    const assertion = yield* prepareAssertion(input);
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const discovery = yield* http
      .execute({ _tag: "Discovery" })
      .pipe(Effect.mapError(() => failure("bancolombia_discovery")));
    if (discovery.status !== successStatus) return yield* failure("bancolombia_discovery");
    yield* Schema.decodeEffect(Schema.fromJsonString(Discovery))(
      new TextDecoder().decode(discovery.body)
    ).pipe(Effect.mapError(() => failure("bancolombia_discovery")));
    const response = yield* http
      .execute({ _tag: "Authenticate", assertion })
      .pipe(Effect.mapError(() => failure("bancolombia_authentication")));
    if (response.status !== successStatus) return yield* failure("bancolombia_authentication");
    yield* Schema.decodeEffect(Schema.fromJsonString(Token))(
      new TextDecoder().decode(response.body)
    ).pipe(Effect.mapError(() => failure("bancolombia_authentication")));
  }).pipe(Effect.asVoid);
