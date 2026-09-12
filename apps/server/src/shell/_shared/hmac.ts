import { createHmac } from "node:crypto";
import { Config, ConfigProvider, Effect, Encoding, Redacted, Result } from "effect";

const hmacKeyPattern = /^[0-9a-f]{64}$/u;
const hmacKeyBytes = 32;

const invalidKey = (variable: string): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: `${variable} must be a 32-byte lowercase hexadecimal key`,
    })
  );

/**
 * Development keys are text; encoding their UTF-8 bytes preserves the exact HMAC semantics they
 * had as strings while keeping every resolved key in one representation.
 */
const developmentHmacKey = (value: string): Redacted.Redacted<Uint8Array> =>
  Redacted.make(new TextEncoder().encode(value));

/**
 * Computes one HMAC-SHA-256 digest over the payload with a resolved key. Callers own the payload
 * encoding and decide whether the digest is persisted as bytes or as hex.
 */
export const hmacSha256 = (input: {
  readonly secret: Redacted.Redacted<Uint8Array>;
  readonly payload: string;
}): Buffer => createHmac("sha256", Redacted.value(input.secret)).update(input.payload).digest();

/**
 * Resolves one validated, redacted 32-byte HMAC key from its lowercase hexadecimal configuration.
 * Production decodes the exact key bytes the named variable's contract promises and fails closed
 * with a value-safe error otherwise; every other environment keeps the supplied local fallback so
 * local runs and tests stay deterministic.
 */
export const configuredHmacKey = (input: {
  readonly variable: string;
  readonly developmentFallback: string;
}): Effect.Effect<Redacted.Redacted<Uint8Array>, Config.ConfigError> =>
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") {
      return developmentHmacKey(input.developmentFallback);
    }
    const encoded = Redacted.value(yield* Config.redacted(input.variable));
    if (!hmacKeyPattern.test(encoded)) {
      return yield* Effect.fail(invalidKey(input.variable));
    }
    const decoded = Encoding.decodeHex(encoded);
    if (Result.isFailure(decoded) || decoded.success.byteLength !== hmacKeyBytes) {
      return yield* Effect.fail(invalidKey(input.variable));
    }
    return Redacted.make(decoded.success);
  });
