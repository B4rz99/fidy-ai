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
import { createLocalJWKSet, jwtVerify } from "jose";
import { makeGoogleOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { loadGoogleClientSecret } from "../../../src/shell/secret-material/operations";
import { digestBytes } from "../../secret-material/operations";
import type { GoogleEnvironment } from "../contract";
import { configuredGoogle, cookieName } from "./start";

const redirectStatus = 303;
const successStatus = 200;
const maximumTokenLength = 16384;
const maximumSubjectLength = 255;
const maximumEmailLength = 320;
const maximumCodeLength = 4096;
const millisecondsPerSecond = 1000;
const Attempt = Schema.Struct({
  id: Schema.String,
  nonce: Schema.String,
  expires_at_ms: Schema.Int,
});
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
  attempt: typeof Attempt.Type;
  current: number;
  clientId: string;
  multipleAudiences: boolean;
}>): boolean => {
  if (claims.nonce !== attempt.nonce || claims.iat * millisecondsPerSecond > current) return false;
  if (claims.azp !== undefined && claims.azp !== clientId) return false;
  return !multipleAudiences || claims.azp === clientId;
};
const validCode = (query: URLSearchParams): boolean => {
  const code = query.get("code") ?? "";
  return (
    !query.has("error") &&
    code.length > 0 &&
    code.length <= maximumCodeLength &&
    query.getAll("code").length === 1
  );
};
const cookieVerifier = (request: Request): Option.Option<string> => {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return Option.none();
  const value = values[0]?.slice(cookieName.length + 1) ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? Option.some(value) : Option.none();
};
const googleHttp = (
  environment: GoogleEnvironment
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

type Validation = Readonly<{
  environment: GoogleEnvironment;
  query: URLSearchParams;
  verifier: string;
  attempt: typeof Attempt.Type;
  current: number;
}>;
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
const validateToken = (
  input: Validation
): Effect.Effect<
  typeof Claims.Type,
  | Config.ConfigError
  | Cause.UnknownError
  | Schema.SchemaError
  | Effect.Error<ReturnType<ReturnType<typeof makeGoogleOutboundHttp>["execute"]>>
  | "invalid",
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const code = input.query.get("code");
    if (!validCode(input.query) || code === null) {
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
    return claims;
  });
const verifyAttempt = (
  input: Validation
): Effect.Effect<void, Cause.UnknownError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const claims = yield* validateToken(input);
    const settled = yield* Clock.currentTimeMillis;
    const changed = yield* Effect.tryPromise(() =>
      input.environment.DB.prepare(
        `UPDATE provider_authentication_attempts SET state='verified',issuer=?,subject=?,contact_email=?,expires_at_ms=MIN(expires_at_ms,?) WHERE id=? AND state='exchanging' AND expires_at_ms>?`
      )
        .bind(
          "https://accounts.google.com",
          claims.sub,
          claims.email ?? null,
          claims.exp * millisecondsPerSecond,
          input.attempt.id,
          settled
        )
        .run()
    );
    if (changed.meta.changes !== 1) {
      return yield* Effect.fail("invalid" as const);
    }
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() =>
      Effect.tryPromise(() =>
        input.environment.DB.prepare(
          "UPDATE provider_authentication_attempts SET state='rejected' WHERE id=? AND state='exchanging'"
        )
          .bind(input.attempt.id)
          .run()
      ).pipe(Effect.asVoid)
    )
  );
const callbackRedirect = (environment: GoogleEnvironment, clearCookie = false): Response =>
  new Response(null, {
    status: redirectStatus,
    headers: {
      location: `${environment.BROWSER_ORIGIN}/auth/google-return`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(clearCookie
        ? { "set-cookie": `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` }
        : {}),
    },
  });
export const googleCallback = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: GoogleEnvironment }>): Effect.Effect<
  Response,
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (!configuredGoogle(environment)) {
      return callbackRedirect(environment);
    }
    const query = new URL(request.url).searchParams;
    const state = query.get("state") ?? "";
    const cookie = cookieVerifier(request);
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
      Option.isNone(cookie) ||
      query.getAll("state").length !== 1
    ) {
      return callbackRedirect(environment);
    }
    const current = yield* Clock.currentTimeMillis;
    const digest = yield* digestBytes(new TextEncoder().encode(cookie.value));
    const row = yield* Effect.tryPromise(() =>
      environment.DB.prepare(`UPDATE provider_authentication_attempts SET state = 'exchanging'
    WHERE id = ? AND cookie_digest = ? AND state = 'pending' AND expires_at_ms > ?
    RETURNING id,nonce,expires_at_ms`)
        .bind(state, digest, current)
        .first()
    );
    const attempt = yield* Schema.decodeUnknownEffect(Attempt)(row);
    yield* verifyAttempt({ environment, query, verifier: cookie.value, attempt, current });
    return callbackRedirect(environment, true);
  }).pipe(Effect.orElseSucceed(() => callbackRedirect(environment)));
