// Test-only platform seam; production cryptography is supplied by the Cloudflare Worker adapter.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash, randomBytes } from "node:crypto";
import { Crypto, Effect, Layer } from "effect";

export const TestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest())
      ),
  })
);
