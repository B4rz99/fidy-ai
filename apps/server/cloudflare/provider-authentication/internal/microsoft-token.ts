import {
  type Cause,
  Clock,
  type Config,
  ConfigProvider,
  DateTime,
  Effect,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { makeMicrosoftOutboundHttp } from "../../../src/shell/outbound-http/operations";
import type { ProviderOidcHttpService } from "../../../src/shell/outbound-http/contract";
import { loadMicrosoftClientSecret } from "../../../src/shell/secret-material/operations";
import type { Validation, VerifiedProviderIdentity } from "./token-contract";

const successStatus = 200;
const millisecondsPerSecond = 1000;
const maximumSubjectLength = 255;
const maximumContactLength = 320;
const maximumTokenLength = 16384;
const issuerTemplate = "https://login.microsoftonline.com/{tenantid}/v2.0";
const TenantClaims = Schema.Struct({
  tid: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  ),
  iss: Schema.String,
});
const Claims = Schema.Struct({
  ...TenantClaims.fields,
  ver: Schema.Literal("2.0"),
  sub: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumSubjectLength)),
  aud: Schema.String,
  nonce: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  email: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumContactLength))),
  preferred_username: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(maximumContactLength))
  ),
});
const TokenResponse = Schema.Struct({
  id_token: Schema.String.check(Schema.isMaxLength(maximumTokenLength)),
});
const SigningKeys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("RSA"),
      n: Schema.String,
      e: Schema.String,
      kid: Schema.String,
      issuer: Schema.String,
      alg: Schema.optionalKey(Schema.String),
      use: Schema.optionalKey(Schema.String),
      key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
    })
  ),
});
type ValidationFailure =
  | Config.ConfigError
  | Cause.UnknownError
  | Schema.SchemaError
  | Effect.Error<ReturnType<ProviderOidcHttpService["execute"]>>
  | "invalid";
const microsoftHttp = (
  input: Validation
): Effect.Effect<ProviderOidcHttpService, Config.ConfigError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const clientSecret = yield* loadMicrosoftClientSecret.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(input.environment)
      )
    );
    return makeMicrosoftOutboundHttp({
      clientId: input.environment.MICROSOFT_CLIENT_ID ?? "",
      clientSecret,
      redirectUri: input.environment.MICROSOFT_REDIRECT_URI ?? "",
      httpClient: yield* HttpClient.HttpClient,
    });
  });
const signingKeys = ({
  http,
  issuer,
  tenant,
}: Readonly<{
  http: ProviderOidcHttpService;
  issuer: string;
  tenant: string;
}>): Effect.Effect<ReturnType<typeof createLocalJWKSet>, ValidationFailure> =>
  Effect.gen(function* () {
    const response = yield* http.execute({ _tag: "SigningKeys" });
    if (response.status !== successStatus) return yield* Effect.fail("invalid" as const);
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(SigningKeys))(
      new TextDecoder().decode(response.body)
    );
    const eligible = decoded.keys.filter(
      (key) => key.issuer.replace("{tenantid}", tenant) === issuer
    );
    if (eligible.length === 0) return yield* Effect.fail("invalid" as const);
    return createLocalJWKSet({
      keys: eligible.map((key) => ({
        ...key,
        key_ops: key.key_ops === undefined ? undefined : [...key.key_ops],
      })),
    });
  });
const validClaims = ({
  claims,
  input,
  clientId,
  current,
}: Readonly<{
  current: number;
  claims: typeof Claims.Type;
  input: Validation;
  clientId: string;
}>): boolean =>
  claims.nonce === input.attempt.nonce &&
  claims.iat * millisecondsPerSecond <= current &&
  claims.aud === clientId;
/** Common authorizes both personal and organizational identities. Every key's issuer scope must match the exact token tenant. */
export const validateMicrosoftToken = (
  input: Validation
): Effect.Effect<VerifiedProviderIdentity, ValidationFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const code = input.query.get("code");
    if (code === null) return yield* Effect.fail("invalid" as const);
    const http = yield* microsoftHttp(input);
    const response = yield* http.execute({
      _tag: "TokenExchange",
      code: Redacted.make(code),
      verifier: Redacted.make(input.verifier),
    });
    if (response.status !== successStatus) return yield* Effect.fail("invalid" as const);
    const token = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(
      new TextDecoder().decode(response.body)
    );
    const untrusted = yield* Effect.try(() => decodeJwt(token.id_token));
    const tenant = yield* Schema.decodeUnknownEffect(TenantClaims)(untrusted);
    const issuer = issuerTemplate.replace("{tenantid}", tenant.tid);
    if (tenant.iss !== issuer) return yield* Effect.fail("invalid" as const);
    const keys = yield* signingKeys({ http, issuer, tenant: tenant.tid });
    const clientId = input.environment.MICROSOFT_CLIENT_ID ?? "";
    const current = yield* Clock.currentTimeMillis;
    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(token.id_token, keys, {
        issuer,
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce", "tid", "ver"],
        clockTolerance: 0,
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(current)),
      })
    );
    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);
    if (!validClaims({ claims, input, clientId, current })) {
      return yield* Effect.fail("invalid" as const);
    }
    return {
      issuer,
      subject: claims.sub,
      contactEmail: Option.fromUndefinedOr(claims.email ?? claims.preferred_username),
      expiresAtMs: claims.exp * millisecondsPerSecond,
    };
  });
