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
export const recoveryId = (): string =>
  Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const symbolCount = 25;

export const sampleBackupCode = (): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(symbolCount)),
    (byte) => alphabet[byte % alphabet.length]
  )
    .join("")
    .match(/.{5}/gu)
    ?.join("-") ?? "";

export const digestBackupCode = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
