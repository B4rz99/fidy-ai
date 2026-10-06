import { Crypto, Effect, type PlatformError, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import { workerCryptoOptions } from "./internal/worker-crypto";

const secretBytes = 32;
const workerCrypto = Crypto.make(workerCryptoOptions);
/** Generate an unpredictable non-secret UUID for a new persisted identity. */
export const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
/** Generate 256 bits of opaque one-time secret authority; disclosure belongs to the owning transport. */
export const newSecret: Effect.Effect<
  Redacted.Redacted<string>,
  PlatformError.PlatformError
> = Effect.suspend(() => workerCrypto.randomBytes(secretBytes)).pipe(
  Effect.map((bytes) => Redacted.make(Base64Url.encode(bytes)))
);
/** Hash one purpose-qualified secret; only its verifier material may be persisted. */
export const secretDigest = (
  input: Readonly<{ purpose: string; value: Redacted.Redacted<string> }>
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  workerCrypto.digest(
    "SHA-256",
    new TextEncoder().encode(`${input.purpose}:${Redacted.value(input.value)}`)
  );
/** Compute protocol-defined SHA-256 verifier material without changing its byte representation. */
export const digestBytes = (
  bytes: Uint8Array
): Effect.Effect<Uint8Array, PlatformError.PlatformError> => workerCrypto.digest("SHA-256", bytes);
