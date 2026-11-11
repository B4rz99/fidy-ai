import { Digest } from "effect/crypto";
import { Effect, PlatformError, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import { makeWorkerSecureRandom } from "./internal/worker-crypto";

const workerDigest = Effect.runSync(Digest.Digest.pipe(Effect.provide(Digest.layerWebCrypto)));
const secretBytes = 32;
const workerSecureRandom = makeWorkerSecureRandom();
/** Generate an unpredictable non-secret UUID for a new persisted identity. */
export const newId = (): string => Effect.runSync(workerSecureRandom.uuidV4().pipe(Effect.orDie));
/** Generate 256 bits of opaque one-time secret authority; disclosure belongs to the owning transport. */
export const newSecret: Effect.Effect<
  Redacted.Redacted<string>,
  PlatformError.PlatformError
> = Effect.suspend(() => workerSecureRandom.randomBytes(secretBytes)).pipe(
  Effect.map((bytes) => Redacted.make(Base64Url.encode(bytes)))
);
/** Hash one purpose-qualified secret; only its verifier material may be persisted. */
export const secretDigest = (
  input: Readonly<{ purpose: string; value: Redacted.Redacted<string> }>
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  workerDigest
    .digest(
      Digest.sha256,
      new TextEncoder().encode(`${input.purpose}:${Redacted.value(input.value)}`)
    )
    .pipe(
      Effect.catchDefect((cause) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "WorkerCrypto",
            method: "digest",
            cause,
          })
        )
      )
    );
/** Compute protocol-defined SHA-256 verifier material without changing its byte representation. */
export const digestBytes = (
  bytes: Uint8Array
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  workerDigest.digest(Digest.sha256, bytes).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        })
      )
    )
  );
