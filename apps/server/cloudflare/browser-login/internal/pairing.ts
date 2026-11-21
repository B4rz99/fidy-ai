import { BrowserLoginPublicCodeSymbols } from "../../../src/core/browser-login/contract";

import {
  formatPublicCode,
  selectPublicCodeSymbols,
} from "../../../src/core/browser-login/operations";
import { Schema } from "effect";

const codeSymbols = 8;

const sampleBytes = 16;

export const samplePublicCode = (): string => {
  let symbols = "";

  while (symbols.length < codeSymbols) {
    symbols += selectPublicCodeSymbols({
      bytes: Array.from(crypto.getRandomValues(new Uint8Array(sampleBytes))),
      maximum: codeSymbols - symbols.length,
    });
  }

  return formatPublicCode(Schema.decodeSync(BrowserLoginPublicCodeSymbols)(symbols));
};
