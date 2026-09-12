import { createHmac } from "node:crypto";
import { Effect, Redacted } from "effect";
import { configuredHmacKey } from "~/shell/_shared/configured-hmac-key";

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
  const secret = yield* configuredHmacKey({
    variable: "SOURCE_ADMISSION_HMAC_KEY",
    developmentFallback: "local-source-admission-key-not-for-production",
  });
  return createHmac("sha256", Redacted.value(secret))
    .update(`${purpose}\u0000${sourceAddress}`)
    .digest();
});
