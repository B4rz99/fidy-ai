import type { SecureRandom } from "effect/crypto";
import { makeWorkerSecureRandom } from "./internal/worker-crypto";

/** Construct Worker-native entropy at a Promise runtime boundary. */
export const makeSecureRandom = (): SecureRandom.SecureRandom["Service"] =>
  makeWorkerSecureRandom();
