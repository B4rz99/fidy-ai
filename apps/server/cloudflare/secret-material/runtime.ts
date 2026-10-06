import { Crypto } from "effect";
import { workerCryptoOptions } from "./internal/worker-crypto";

/** Construct Worker-native security entropy and hashing at a Promise runtime boundary. */
export const makeWorkerCrypto = (): Crypto.Crypto => Crypto.make(workerCryptoOptions);
