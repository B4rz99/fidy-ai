import { Effect, PlatformError, Redacted } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { workerSecureRandom } from "./internal/worker-crypto";

const secretBytes = 32;

export const newId = (): string => SecureRandom.uuidV4Unsafe();

export const newSecret: Effect.Effect<
  Redacted.Redacted<string>,
  PlatformError.PlatformError
> = Effect.suspend(() => workerSecureRandom.randomBytes(secretBytes)).pipe(
  Effect.map((bytes) => Redacted.make(Base64Url.encode(bytes)))
);

const digestFailure = (cause: unknown): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: "WorkerCrypto",
    method: "digest",
    description: "SHA-256 digest unavailable",
    cause,
  });

export const digestBytes = (
  bytes: Uint8Array
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle
        .digest("SHA-256", new Uint8Array(bytes))
        .then((digest) => new Uint8Array(digest)),
    catch: digestFailure,
  });

export const secretDigest = (
  input: Readonly<{ purpose: string; value: Redacted.Redacted<string> }>
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  digestBytes(new TextEncoder().encode(`${input.purpose}:${Redacted.value(input.value)}`));
