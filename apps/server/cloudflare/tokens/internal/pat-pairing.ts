import { selectPATPairingPublicCodeSymbols } from "../../../src/core/tokens/operations";
import {
  httpRateLimited,
  pairingRateLimitedSeconds,
  pairingRejectedMessage,
  response,
} from "./pat-shared";

const symbolCount = 8;

const sampleBytes = 16;

const pairingRateLimitedBody = {
  error: {
    code: "rate_limited",
    message: pairingRejectedMessage,
    retryAfterSeconds: pairingRateLimitedSeconds,
  },
  next: [],
} as const;

export const rateLimited = (): Response =>
  response({ body: pairingRateLimitedBody, status: httpRateLimited });

export const publicCode = (): string => {
  let symbols = "";

  while (symbols.length < symbolCount) {
    symbols += selectPATPairingPublicCodeSymbols({
      bytes: Array.from(crypto.getRandomValues(new Uint8Array(sampleBytes))),
      maximum: symbolCount - symbols.length,
    });
  }

  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};
