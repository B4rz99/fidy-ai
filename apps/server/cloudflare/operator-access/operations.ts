import { Clock, DateTime, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { OutboundHttpRequest } from "../../src/shell/outbound-http/contract";
import type { OutboundHttpService } from "../../src/shell/outbound-http/operations";

export type OperatorAccessConfiguration = Readonly<{
  issuer: string;
  audience: string;
  requiredEmail: Option.Option<string>;
  otherAudiences: ReadonlyArray<string>;
}>;

const maximumAssertionBytes = 8192;

const maximumLifetimeSeconds = 900;

const millisecondsPerSecond = 1000;

const maximumSubjectLength = 256;

const Claims = Schema.Struct({
  type: Schema.Literal("app"),
  aud: Schema.Union([
    Schema.String,
    Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(1)),
  ]),
  sub: Schema.String.check(Schema.isBetweenLength(1, maximumSubjectLength)),
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/u)),
  iat: Schema.Int,
  exp: Schema.Int,
});

const configured = (config: OperatorAccessConfiguration): boolean =>
  /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(config.issuer) &&
  config.audience.length > 0 &&
  !config.otherAudiences.includes(config.audience);

const signingKeysRuntime = ManagedRuntime.make(Layer.empty);

const signingKeys = (
  input: Readonly<{
    request: Request;
    configuration: OperatorAccessConfiguration;
    http: OutboundHttpService;
  }>
): ReturnType<typeof createRemoteJWKSet> =>
  createRemoteJWKSet(new URL(`${input.configuration.issuer}/cdn-cgi/access/certs`), {
    [customFetch]: (_url, options): Promise<Response> =>
      signingKeysRuntime.runPromise(
        input.http.execute(OutboundHttpRequest.CloudflareAccessSigningKeys()).pipe(
          Effect.timeout("5 seconds"),
          Effect.map(
            (response) =>
              new Response(Uint8Array.from(response.body), {
                status: response.status,
                headers: { "content-type": "application/json" },
              })
          )
        ),
        { signal: AbortSignal.any([input.request.signal, options.signal]) }
      ),
  });

export const authenticateOperator = (
  input: Readonly<{
    request: Request;
    configuration: OperatorAccessConfiguration;
    http: OutboundHttpService;
  }>
): Effect.Effect<Option.Option<Readonly<{ operatorRef: string; expiresAtMs: number }>>> =>
  Effect.gen(function* () {
    const assertion = input.request.headers.get("cf-access-jwt-assertion");

    if (
      !configured(input.configuration) ||
      assertion === null ||
      assertion.length > maximumAssertionBytes
    ) {
      return Option.none();
    }

    const clock = yield* Clock.Clock;
    const keys = signingKeys(input);

    const verified = yield* Effect.tryPromise(() =>
      jwtVerify(assertion, keys, {
        issuer: input.configuration.issuer,
        audience: input.configuration.audience,
        algorithms: ["RS256"],
        get currentDate(): Date {
          return DateTime.toDateUtc(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
        },
      })
    );

    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);
    const now = Math.floor(clock.currentTimeMillisUnsafe() / millisecondsPerSecond);

    if (
      !currentClaims(claims, now) ||
      "common_name" in verified.payload ||
      Option.exists(input.configuration.requiredEmail, (email) => claims.email !== email)
    ) {
      return Option.none();
    }

    return Option.some({
      operatorRef: claims.sub,
      expiresAtMs: claims.exp * millisecondsPerSecond,
    });
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => Option.none())
  );

const currentClaims = (claims: typeof Claims.Type, current: number): boolean =>
  claims.iat <= current &&
  claims.exp > current &&
  claims.exp > claims.iat &&
  claims.exp - claims.iat <= maximumLifetimeSeconds;
