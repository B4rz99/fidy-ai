import { Crypto, Effect, PlatformError } from "effect";

/** Uses browser entropy and digest APIs through the shared Effect Crypto interface. */
export const browserCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        globalThis.crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((digest) => new Uint8Array(digest)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "BrowserCrypto",
          method: "digest",
          cause,
        }),
    }),
});
