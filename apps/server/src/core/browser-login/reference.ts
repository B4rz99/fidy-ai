import { Schema } from "effect";

/** Stable, non-secret identity of one BrowserLoginPairing. */
export const BrowserLoginPairingId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserLoginPairingId"))
  .annotate({ identifier: "BrowserLoginPairingId" });
export type BrowserLoginPairingId = typeof BrowserLoginPairingId.Type;
