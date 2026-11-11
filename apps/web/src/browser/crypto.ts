import { SecureRandom } from "effect/crypto";

export const browserSecureRandom = SecureRandom.make((size) =>
  globalThis.crypto.getRandomValues(new Uint8Array(size))
);
