import { selectPATPairingPublicCodeSymbols } from "../../../src/core/tokens/operations";
import { httpRateLimited, pairingRejectedMessage, response } from "./pat-shared";

const symbolCount = 8;

const sampleBytes = 16;

export const reviewRetrySeconds = 60;

export const rateLimited = (): Response =>
  response({
    body: {
      error: {
        code: "rate_limited",
        message: pairingRejectedMessage,
        retryAfterSeconds: reviewRetrySeconds,
      },
      next: [],
    },
    status: httpRateLimited,
  });

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
