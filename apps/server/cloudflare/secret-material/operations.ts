import { Crypto, Effect, PlatformError } from "effect";

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((bytes) => new Uint8Array(bytes)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});
/** Generate an unpredictable non-secret UUID for a new persisted identity. */
export const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
