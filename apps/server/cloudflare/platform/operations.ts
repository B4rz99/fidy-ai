import { Clock, Crypto, Effect, PlatformError } from "effect";

/** Server-observed time, never a caller-supplied deadline. */
export const currentMillis = (): number => Effect.runSync(Clock.currentTimeMillis);

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

/** Draw a fresh identity without granting domain or User authority. */
export const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
