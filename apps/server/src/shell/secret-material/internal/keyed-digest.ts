// Node crypto is required because Effect Crypto does not expose HMAC.
// @effect-diagnostics-next-line nodeBuiltinImport:off
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

/** Keeps local deterministic text keys byte-for-byte compatible with their previous HMAC use. */
const developmentKey = (value: string): Redacted.Redacted<Uint8Array> =>
  Redacted.make(new TextEncoder().encode(value));

/** Resolves one private HMAC key for a purpose operation in this module. */
export const configuredHmacKey = (input: {
  readonly variable: string;
  readonly developmentFallback: string;
}): Effect.Effect<Redacted.Redacted<Uint8Array>, Config.ConfigError> =>
  Effect.gen(function* () {
    const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return developmentKey(input.developmentFallback);

    const encoded = Redacted.value(yield* Config.Redacted(input.variable));
    if (!hmacKeyPattern.test(encoded)) return yield* Effect.fail(invalidKey(input.variable));

    const decoded = Encoding.decodeHex(encoded);
    if (Result.isFailure(decoded) || decoded.success.byteLength !== hmacKeyBytes) {
      return yield* Effect.fail(invalidKey(input.variable));
    }
    return Redacted.make(decoded.success);
  });

/** Computes the private HMAC primitive used only by this module's purpose operations. */
export const hmacSha256 = (input: {
  readonly secret: Redacted.Redacted<Uint8Array>;
  readonly payload: string;
}): Buffer => createHmac("sha256", Redacted.value(input.secret)).update(input.payload).digest();
