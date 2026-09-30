import { Crypto, Effect, PlatformError } from "effect";

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(bytes))
          .then((digest) => new Uint8Array(digest)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});
export const pairingId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
