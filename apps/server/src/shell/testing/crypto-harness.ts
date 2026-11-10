import { Layer } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

export const TestSecureRandom = SecureRandom.layerWebCrypto;
export const TestDigest = Digest.layerWebCrypto;
export const TestCrypto = Layer.mergeAll(TestSecureRandom, TestDigest);
