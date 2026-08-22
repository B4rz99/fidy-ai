import { Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "./reference";
import { BrowserLoginPublicCode, browserLoginPollingIntervalSeconds } from "./rules";

/** One-time browser proof: exactly 32 random octets as unpadded base64url. */
export const BrowserLoginPrivateVerifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)
)
  .pipe(Schema.brand("BrowserLoginPrivateVerifier"))
  .annotate({ identifier: "BrowserLoginPrivateVerifier" });
export type BrowserLoginPrivateVerifier = typeof BrowserLoginPrivateVerifier.Type;

/** Secret-bearing direct-HTTPS response; never a canonical operation result. */
export const StartedBrowserLoginPairing = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.RedactedFromValue(BrowserLoginPrivateVerifier),
  publicCode: BrowserLoginPublicCode,
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Literal(browserLoginPollingIntervalSeconds),
}).annotate({ identifier: "StartedBrowserLoginPairing" });
export type StartedBrowserLoginPairing = typeof StartedBrowserLoginPairing.Type;
