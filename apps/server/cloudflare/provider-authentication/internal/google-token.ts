import {
  type Cause,
  type Config,
  ConfigProvider,
  DateTime,
  Effect,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { createLocalJWKSet, jwtVerify } from "jose";
import { makeGoogleOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { loadGoogleClientSecret } from "../../../src/shell/secret-material/operations";

import type { ProviderEnvironment } from "../contract";
import type { Validation, VerifiedProviderIdentity } from "./token-contract";

const successStatus = 200;
const maximumTokenLength = 16384;
const maximumSubjectLength = 255;
const maximumEmailLength = 320;
const millisecondsPerSecond = 1000;
const TokenResponse = Schema.Struct({
  id_token: Schema.String.check(Schema.isMaxLength(maximumTokenLength)),
});
const Claims = Schema.Struct({
  iss: Schema.Literals(["https://accounts.google.com", "accounts.google.com"]),
  sub: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumSubjectLength)),
  nonce: Schema.String,
  exp: Schema.Int,
  iat: Schema.Int,
  email: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumEmailLength))),
  azp: Schema.optionalKey(Schema.String),
});
const validClaims = ({
  claims,
  attempt,
  current,
  clientId,
  multipleAudiences,
}: Readonly<{
  claims: typeof Claims.Type;
  attempt: Validation["attempt"];
  current: number;
  clientId: string;
  multipleAudiences: boolean;
}>): boolean => {
  if (claims.nonce !== attempt.nonce || claims.iat * millisecondsPerSecond > current) return false;
  if (claims.azp !== undefined && claims.azp !== clientId) return false;
  return !multipleAudiences || claims.azp === clientId;
};
const googleHttp = (
  environment: ProviderEnvironment
): Effect.Effect<
  ReturnType<typeof makeGoogleOutboundHttp>,
  Config.ConfigError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const clientSecret = yield* loadGoogleClientSecret.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment))
    );
    return makeGoogleOutboundHttp({
      clientId: environment.GOOGLE_CLIENT_ID ?? "",
      clientSecret,
      redirectUri: environment.GOOGLE_REDIRECT_URI ?? "",
      httpClient: yield* HttpClient.HttpClient,
    });
  });

const SigningKeys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("RSA"),
      n: Schema.String,
      e: Schema.String,
      kid: Schema.optionalKey(Schema.String),
      alg: Schema.optionalKey(Schema.String),
      use: Schema.optionalKey(Schema.String),
      key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
    })
  ),
});
const signingKeys = (
  http: ReturnType<typeof makeGoogleOutboundHttp>
): Effect.Effect<
  ReturnType<typeof createLocalJWKSet>,
  | Effect.Error<ReturnType<ReturnType<typeof makeGoogleOutboundHttp>["execute"]>>
  | Schema.SchemaError
  | "invalid"
> =>
  Effect.gen(function* () {
    const response = yield* http.execute({ _tag: "SigningKeys" });
    if (response.status !== successStatus) {
      return yield* Effect.fail("invalid" as const);
    }
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(SigningKeys))(
      new TextDecoder().decode(response.body)
    );
    return createLocalJWKSet({
      keys: [...decoded.keys].map((key) => ({
        ...key,
        key_ops: key.key_ops === undefined ? undefined : [...key.key_ops],
      })),
    });
  });
export const validateGoogleToken = (
  input: Validation
): Effect.Effect<
  VerifiedProviderIdentity,
  | Config.ConfigError
  | Cause.UnknownError
  | Schema.SchemaError
  | Effect.Error<ReturnType<ReturnType<typeof makeGoogleOutboundHttp>["execute"]>>
  | "invalid",
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const code = input.query.get("code");
    if (code === null) {
      return yield* Effect.fail("invalid" as const);
    }
    const clientId = input.environment.GOOGLE_CLIENT_ID ?? "";
    const http = yield* googleHttp(input.environment);
    const response = yield* http.execute({
      _tag: "TokenExchange",
      code: Redacted.make(code),
      verifier: Redacted.make(input.verifier),
    });
    if (response.status !== successStatus) {
      return yield* Effect.fail("invalid" as const);
    }
    const token = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(
      new TextDecoder().decode(response.body)
    );
    const keys = yield* signingKeys(http);
    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(token.id_token, keys, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"],
        clockTolerance: 0,
        currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(input.current)),
      })
    );
    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);
    if (
      !validClaims({
        claims,
        attempt: input.attempt,
        current: input.current,
        clientId,
        multipleAudiences: Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1,
      })
    ) {
      return yield* Effect.fail("invalid" as const);
    }
    return {
      issuer: "https://accounts.google.com",
      subject: claims.sub,
      contactEmail: Option.fromUndefinedOr(claims.email),
      expiresAtMs: claims.exp * millisecondsPerSecond,
    };
  });
