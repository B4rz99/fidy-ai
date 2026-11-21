import {
  Clock,
  type Config,
  ConfigProvider,
  Data,
  DateTime,
  Effect,
  Option,
  Redacted,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import { makeGoogleOutboundHttp } from "../../../src/shell/outbound-http/operations";
import type { ProviderOidcHttpService } from "../../../src/shell/outbound-http/contract";
import { loadGoogleClientSecret } from "../../../src/shell/secret-material/operations";

import type { ProviderConfiguration } from "../contract";
import {
  ProviderVerificationFailure,
  type Validation,
  type VerifiedProviderIdentity,
} from "./token-contract";

const OidcRequest = Data.taggedEnum<Parameters<ProviderOidcHttpService["execute"]>[0]>();

const isJwtExpired = Schema.is(Schema.instanceOf(errors.JWTExpired));

const isJwtClaimValidationFailed = Schema.is(Schema.instanceOf(errors.JWTClaimValidationFailed));

const isJwksNoMatchingKey = Schema.is(Schema.instanceOf(errors.JWKSNoMatchingKey));

const isJwsSignatureVerificationFailed = Schema.is(
  Schema.instanceOf(errors.JWSSignatureVerificationFailed)
);

const successStatus = 200;

const maximumTokenLength = 16384;

const maximumSubjectLength = 255;

const maximumEmailLength = 320;

const millisecondsPerSecond = 1000;

const TokenResponse = Schema.Struct({
  id_token: Schema.String.check(Schema.isMaxLength(maximumTokenLength)),
});

const TokenRefusal = Schema.Struct({
  error: Schema.Literals(["invalid_client", "invalid_grant"]),
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
}>): Effect.Effect<void, ProviderVerificationFailure> => {
  if (claims.nonce !== attempt.nonce) {
    return Effect.fail(
      new ProviderVerificationFailure({
        reason: "nonce_mismatch",
        cause: Option.none(),
      })
    );
  }

  if (claims.iat * millisecondsPerSecond > current) {
    return Effect.fail(
      new ProviderVerificationFailure({
        reason: "issued_in_future",
        cause: Option.none(),
      })
    );
  }

  if (
    (claims.azp !== undefined && claims.azp !== clientId) ||
    (multipleAudiences && claims.azp !== clientId)
  ) {
    return Effect.fail(
      new ProviderVerificationFailure({
        reason: "authorized_party_mismatch",
        cause: Option.none(),
      })
    );
  }

  return Effect.void;
};

const googleHttp = (
  environment: ProviderConfiguration
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
    const response = yield* http.execute(OidcRequest.SigningKeys());

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

const verificationFailure =
  (reason: ProviderVerificationFailure["reason"]) =>
  (cause: unknown): ProviderVerificationFailure =>
    new ProviderVerificationFailure({ reason, cause: Option.some(cause) });

const tokenVerificationFailure = (failure: unknown): ProviderVerificationFailure => {
  if (isJwtExpired(failure)) {
    return new ProviderVerificationFailure({
      reason: "token_expired",
      cause: Option.none(),
    });
  }

  if (isJwtClaimValidationFailed(failure)) {
    if (failure.claim === "aud") {
      return new ProviderVerificationFailure({
        reason: "audience_mismatch",
        cause: Option.none(),
      });
    }

    if (failure.claim === "iss") {
      return new ProviderVerificationFailure({
        reason: "issuer_mismatch",
        cause: Option.none(),
      });
    }

    return new ProviderVerificationFailure({
      reason: "claims_invalid",
      cause: Option.none(),
    });
  }

  if (isJwksNoMatchingKey(failure)) {
    return new ProviderVerificationFailure({
      reason: "signing_key_unmatched",
      cause: Option.none(),
    });
  }

  if (isJwsSignatureVerificationFailed(failure)) {
    return new ProviderVerificationFailure({
      reason: "signature_invalid",
      cause: Option.none(),
    });
  }

  return new ProviderVerificationFailure({
    reason: "token_verification_failed",
    cause: Option.none(),
  });
};

const exchangeToken = (
  http: ProviderOidcHttpService,
  code: string,
  verifier: string
): Effect.Effect<typeof TokenResponse.Type, ProviderVerificationFailure> =>
  Effect.gen(function* () {
    const response = yield* http
      .execute(
        OidcRequest.TokenExchange({
          code: Redacted.make(code),
          verifier: Redacted.make(verifier),
        })
      )
      .pipe(Effect.mapError(verificationFailure("token_transport_failed")));

    if (response.status !== successStatus) {
      const refusal = Schema.decodeOption(Schema.fromJsonString(TokenRefusal))(
        new TextDecoder().decode(response.body)
      );

      if (Option.isSome(refusal)) {
        return yield* new ProviderVerificationFailure({
          reason:
            refusal.value.error === "invalid_client"
              ? "token_invalid_client"
              : "token_invalid_grant",
          cause: Option.none(),
        });
      }

      return yield* new ProviderVerificationFailure({
        reason: "token_refused",
        cause: Option.none(),
      });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(
      new TextDecoder().decode(response.body)
    ).pipe(Effect.mapError(verificationFailure("token_response_invalid")));
  });

export const validateGoogleToken = (
  input: Validation
): Effect.Effect<
  VerifiedProviderIdentity,
  ProviderVerificationFailure | "invalid",
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const code = input.query.get("code");

    if (code === null) {
      return yield* Effect.fail("invalid" as const);
    }

    const clientId = input.environment.GOOGLE_CLIENT_ID ?? "";

    const http = yield* googleHttp(input.environment).pipe(
      Effect.mapError(verificationFailure("configuration_invalid"))
    );

    const token = yield* exchangeToken(http, code, input.verifier);

    const keys = yield* signingKeys(http).pipe(
      Effect.mapError(verificationFailure("signing_keys_failed"))
    );

    const current = yield* Clock.currentTimeMillis;

    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token.id_token, keys, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: clientId,
          algorithms: ["RS256"],
          requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"],
          clockTolerance: 0,
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(current)),
        }),
      catch: tokenVerificationFailure,
    });

    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload).pipe(
      Effect.mapError(verificationFailure("claims_invalid"))
    );

    yield* validClaims({
      claims,
      attempt: input.attempt,
      current,
      clientId,
      multipleAudiences: Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1,
    });

    return {
      issuer: "https://accounts.google.com",
      subject: claims.sub,
      contactEmail: Option.fromUndefinedOr(claims.email),
      expiresAtMs: claims.exp * millisecondsPerSecond,
    };
  });
