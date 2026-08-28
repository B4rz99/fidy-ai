import { Config, Context, Data, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";
import { SupportOperatorId } from "~/core/recovery/model";

const AccessIssuer = Schema.String.check(
  Schema.isPattern(/^https:\/\/[^/]+\.cloudflareaccess\.com\/?$/u)
);
const AccessAudience = Schema.String.check(Schema.isNonEmpty());
const accessAssertionLifetimeMinutes = 15;
const secondsPerMinute = 60;
const millisecondsPerSecond = 1_000;
const maximumAccessAssertionLifetimeSeconds = accessAssertionLifetimeMinutes * secondsPerMinute;

/** Safe authentication refusal; JWT details never cross the private transport boundary. */
export class SupportAccessUnauthorized extends Data.TaggedError("SupportAccessUnauthorized")<{}> {}

/** Safe typed failure for unavailable Access key infrastructure. */
export class SupportAccessUnavailable extends Data.TaggedError("SupportAccessUnavailable")<{}> {}

type SupportAccessVerifierService = Readonly<{
  verify: (
    assertion: Redacted.Redacted<string>
  ) => Effect.Effect<SupportOperatorId, SupportAccessUnauthorized | SupportAccessUnavailable>;
}>;

const makeVerifier = (input: {
  issuer: string;
  audience: string;
  jwks: JWTVerifyGetKey;
}): SupportAccessVerifierService =>
  SupportAccessVerifier.of({
    verify: (assertion) =>
      Effect.tryPromise({
        try: () =>
          jwtVerify(Redacted.value(assertion), input.jwks, {
            algorithms: ["RS256"],
            audience: input.audience,
            issuer: input.issuer,
          }),
        catch: (error) =>
          error instanceof TypeError
            ? new SupportAccessUnavailable()
            : new SupportAccessUnauthorized(),
      }).pipe(
        Effect.flatMap(({ payload }) =>
          DateTime.now.pipe(
            Effect.flatMap((now) => {
              const claims = Schema.decodeUnknownOption(
                Schema.Struct({
                  sub: Schema.String.check(Schema.isNonEmpty()),
                  iat: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
                  exp: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
                })
              )(payload);
              const nowEpochSeconds = Math.floor(now.epochMilliseconds / millisecondsPerSecond);
              if (
                claims._tag === "None" ||
                claims.value.iat > nowEpochSeconds ||
                claims.value.exp <= claims.value.iat ||
                claims.value.exp - claims.value.iat > maximumAccessAssertionLifetimeSeconds ||
                claims.value.exp - nowEpochSeconds > maximumAccessAssertionLifetimeSeconds
              ) {
                return Effect.fail(new SupportAccessUnauthorized());
              }
              return Effect.succeed(
                SupportOperatorId.make({ issuer: input.issuer, subject: claims.value.sub })
              );
            })
          )
        )
      ),
  });

/** Builds the same exact-claim verifier with a supplied JWKS source for boundary tests. */
export const makeSupportAccessVerifier = makeVerifier;

/** Origin-side verifier for the Access assertion Cloudflare forwards to Railway. */
export class SupportAccessVerifier extends Context.Service<
  SupportAccessVerifier,
  {
    readonly verify: (
      assertion: Redacted.Redacted<string>
    ) => Effect.Effect<SupportOperatorId, SupportAccessUnauthorized | SupportAccessUnavailable>;
  }
>()("@fidy/server/shell/recovery/access/SupportAccessVerifier") {
  static readonly layer = Layer.effect(
    SupportAccessVerifier,
    Effect.gen(function* () {
      const issuerUrl = yield* Config.schema(AccessIssuer, "CLOUDFLARE_ACCESS_ISSUER");
      const audience = yield* Config.schema(AccessAudience, "CLOUDFLARE_ACCESS_AUDIENCE");
      const issuer = issuerUrl.replace(/\/$/u, "");
      const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      return makeVerifier({ issuer, audience, jwks });
    })
  );
}
