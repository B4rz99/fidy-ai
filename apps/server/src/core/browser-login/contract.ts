import { Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
/** Stable, non-secret identity of one BrowserLoginPairing; possession grants no authority. */
export const BrowserLoginPairingId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserLoginPairingId"))
  .annotate({ identifier: "BrowserLoginPairingId" });
export type BrowserLoginPairingId = typeof BrowserLoginPairingId.Type;

/** Minimum cadence advertised to browsers polling a pairing challenge. */
export const browserLoginPollingIntervalSeconds = 5;

/** Unambiguous base-20 alphabet used by every public-code representation. */
export const browserLoginPublicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" as const;
const publicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;
const publicSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

/** Public locator; possession never establishes browser or stable-User authority. */
export const BrowserLoginPublicCode = Schema.String.check(Schema.isPattern(publicCodePattern))
  .pipe(Schema.brand("BrowserLoginPublicCode"))
  .annotate({ identifier: "BrowserLoginPublicCode" });
export type BrowserLoginPublicCode = typeof BrowserLoginPublicCode.Type;

/** Eight sampled symbols before display formatting. */
export const BrowserLoginPublicCodeSymbols = Schema.String.check(
  Schema.isPattern(publicSymbolsPattern)
).pipe(Schema.brand("BrowserLoginPublicCodeSymbols"));
export type BrowserLoginPublicCodeSymbols = typeof BrowserLoginPublicCodeSymbols.Type;

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

/** Lifecycle vocabulary used by total pairing decisions, not a persistence projection. */
export const BrowserLoginPairingLifecycle = Schema.Literals([
  "pending_approval",
  "ready",
  "expired",
  "superseded",
  "consumed",
  "invalidated",
]);
export type BrowserLoginPairingLifecycle = typeof BrowserLoginPairingLifecycle.Type;

const normalizePublicCode = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();
  if (publicCodePattern.test(upper)) return upper;
  return publicSymbolsPattern.test(upper) ? `${upper.slice(0, 4)}-${upper.slice(4)}` : upper;
};

/** Narrow ASCII presentation normalization; encoding always emits the canonical public spelling. */
export const BrowserLoginPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    BrowserLoginPublicCode,
    SchemaTransformation.transform({ decode: normalizePublicCode, encode: (code) => code })
  )
);
