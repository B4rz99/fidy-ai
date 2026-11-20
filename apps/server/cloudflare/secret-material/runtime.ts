import type { SecureRandom } from "effect/crypto";
import { makeWorkerSecureRandom } from "./internal/worker-crypto";

export const makeSecureRandom = (): SecureRandom.SecureRandom["Service"] =>
  makeWorkerSecureRandom();
