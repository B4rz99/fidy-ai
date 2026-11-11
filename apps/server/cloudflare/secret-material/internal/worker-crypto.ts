import { SecureRandom } from "effect/crypto";

export const makeWorkerSecureRandom = (): SecureRandom.SecureRandom["Service"] =>
  SecureRandom.make((size) => crypto.getRandomValues(new Uint8Array(size)));
