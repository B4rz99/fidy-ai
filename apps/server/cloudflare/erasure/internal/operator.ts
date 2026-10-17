import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { ErasureUnavailable } from "../../erasure-store/contract";
import type { ErasureOperatorConfiguration } from "../contract";

const maximumAssertionBytes = 8192;
const maximumLifetimeSeconds = 900;
const millisecondsPerSecond = 1000;
const maximumSubjectLength = 256;
const Claims = Schema.Struct({
  sub: Schema.String.check(Schema.isBetweenLength(1, maximumSubjectLength)),
  email: Schema.Literal("obarboza@fidyapp.com"),
  iat: Schema.Int,
  exp: Schema.Int,
});
const configured = (config: ErasureOperatorConfiguration): boolean =>
  /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u.test(config.issuer) &&
  config.audience.length > 0 &&
  config.audience !== config.recoveryAudience &&
  config.audience !== config.billingAudience;

const signingKeys = (
  input: Readonly<{
    request: Request;
    configuration: ErasureOperatorConfiguration;
    http: OutboundHttpService;
  }>
): ReturnType<typeof createRemoteJWKSet> =>
  createRemoteJWKSet(new URL(`${input.configuration.issuer}/cdn-cgi/access/certs`), {
    [customFetch]: (_url, options): Promise<Response> =>
      Effect.runPromise(
        input.http.execute({ _tag: "CloudflareAccessSigningKeys" }).pipe(
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
    configuration: ErasureOperatorConfiguration;
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
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(assertion, keys, {
          issuer: input.configuration.issuer,
          audience: input.configuration.audience,
          algorithms: ["RS256"],
          get currentDate(): Date {
            return DateTime.toDateUtc(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
          },
        }),
      catch: () => new ErasureUnavailable(),
    });
    const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload);
    const now = Math.floor(clock.currentTimeMillisUnsafe() / millisecondsPerSecond);
    if (!currentClaims(claims, now) || "common_name" in verified.payload) return Option.none();
    return Option.some({
      operatorRef: claims.sub,
      expiresAtMs: claims.exp * millisecondsPerSecond,
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const currentClaims = (claims: typeof Claims.Type, current: number): boolean =>
  claims.iat <= current &&
  claims.exp > current &&
  claims.exp > claims.iat &&
  claims.exp - claims.iat <= maximumLifetimeSeconds;
