// Test-only platform seam; production cryptography is supplied by the Cloudflare Worker adapter.
import { Crypto, Effect, Layer } from "effect";

const maximumWebCryptoBytes = 65_536;
const testRandomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += maximumWebCryptoBytes) {
    crypto.getRandomValues(bytes.subarray(offset, offset + maximumWebCryptoBytes));
  }
  return bytes;
};

const digestNames: Readonly<
  Record<Crypto.DigestAlgorithm, ConstructorParameters<typeof Bun.CryptoHasher>[0]>
> = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

export const TestCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: testRandomBytes,
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(new Bun.CryptoHasher(digestNames[algorithm]).update(data).digest())
      ),
  })
);
