import { createHmac } from "node:crypto";
import { Config, ConfigProvider, Effect, Redacted } from "effect";

const hmacKeyPattern = /^[0-9a-f]{64}$/u;

/**
 * Computes one HMAC-SHA-256 digest over the payload with a resolved key. Callers own the payload
 * encoding and decide whether the digest is persisted as bytes or as hex.
 */
export const hmacSha256 = (input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: string;
}): Buffer => createHmac("sha256", Redacted.value(input.secret)).update(input.payload).digest();

/**
 * Resolves one validated, redacted 32-byte HMAC key. Production requires the named variable to
 * hold lowercase hexadecimal key material and fails closed with a value-safe error otherwise; every
 * other environment keeps the supplied local fallback so local runs and tests stay deterministic.
 */
export const configuredHmacKey = (input: {
  readonly variable: string;
  readonly developmentFallback: string;
}): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> =>
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") {
      return Redacted.make(input.developmentFallback);
    }
    const secret = yield* Config.redacted(input.variable);
    if (!hmacKeyPattern.test(Redacted.value(secret))) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `${input.variable} must be a 32-byte lowercase hexadecimal key`,
          })
        )
      );
    }
    return secret;
  });
