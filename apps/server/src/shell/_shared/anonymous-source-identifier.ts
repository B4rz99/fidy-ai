import { createHmac } from "node:crypto";
import { Config, ConfigProvider, Effect, Redacted } from "effect";

const sourceAdmissionHmacKeyPattern = /^[0-9a-f]{64}$/u;
const invalidSourceAdmissionHmacKey = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message: "SOURCE_ADMISSION_HMAC_KEY must be a 32-byte lowercase hexadecimal key",
    })
  );

/**
 * One anonymous admission purpose. Purposes are separate namespaces: an identifier derived for one
 * purpose is never comparable with an identifier derived for another.
 */
export type AnonymousSourcePurpose =
  | "browser-login-start"
  | "pat-pairing-start"
  | "pat-pairing-claim";

/**
 * Derives the keyed, purpose-scoped identifier stored as anonymous source admission evidence. Equal
 * observed addresses group under one identifier within a purpose and cannot be correlated across
 * purposes. The identifier is abuse-admission input only, never identity or authorization
 * authority. Production requires a validated, redacted `SOURCE_ADMISSION_HMAC_KEY`; an absent,
 * empty, or malformed key fails with a configuration error that never contains the key or the
 * address.
 */
export const anonymousSourceIdentifier = Effect.fn(function* (
  purpose: AnonymousSourcePurpose,
  sourceAddress: string
) {
  const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
  let secret = Redacted.make("local-source-admission-key-not-for-production");
  if (environment === "production") {
    secret = yield* Config.redacted("SOURCE_ADMISSION_HMAC_KEY");
    if (!sourceAdmissionHmacKeyPattern.test(Redacted.value(secret))) {
      return yield* Effect.fail(invalidSourceAdmissionHmacKey());
    }
  }
  return createHmac("sha256", Redacted.value(secret))
    .update(`${purpose}\u0000${sourceAddress}`)
    .digest();
});
