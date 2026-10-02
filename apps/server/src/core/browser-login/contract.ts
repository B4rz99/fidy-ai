import { type DateTime, type Option, Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "./reference";

/** Minimum cadence advertised to browsers polling a pairing challenge. */
export const browserLoginPollingIntervalSeconds = 5;

/** Unambiguous base-20 alphabet used by every public-code representation. */
export const browserLoginPublicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" as const;

const browserLoginPublicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;
const browserLoginPublicCodeSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

/** Public, human-entered code. Its possession never establishes a browser session. */
export const BrowserLoginPublicCode = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodePattern)
)
  .pipe(Schema.brand("BrowserLoginPublicCode"))
  .annotate({ identifier: "BrowserLoginPublicCode" });
export type BrowserLoginPublicCode = typeof BrowserLoginPublicCode.Type;

/** Fixed lifetime applied by the server when it creates an unbound challenge. */
export const browserLoginPairingLifetime = "10 minutes" as const;

/** Eight validated symbols sampled from the public-code alphabet before display formatting. */
export const BrowserLoginPublicCodeSymbols = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodeSymbolsPattern)
).pipe(Schema.brand("BrowserLoginPublicCodeSymbols"));
export type BrowserLoginPublicCodeSymbols = typeof BrowserLoginPublicCodeSymbols.Type;

/** Persisted lifecycle values against which redemption decisions are total. */
export const BrowserLoginPairingLifecycle = Schema.Literals([
  "pending_approval",
  "ready",
  "expired",
  "superseded",
  "consumed",
  "invalidated",
]);
export type BrowserLoginPairingLifecycle = typeof BrowserLoginPairingLifecycle.Type;

/** Authoritative pairing state and exact proof result at one polling decision instant. */
export type RedemptionInput = Readonly<{
  lifecycle: BrowserLoginPairingLifecycle;
  verifierMatches: boolean;
  wrongVerifierAttempts: number;
  minimumPollIntervalSeconds: number;
  lastAcceptedPollAt: Option.Option<DateTime.Utc>;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

/** Closed result set consumed by the transactional redemption shell. */
export type BrowserLoginRedemptionDecision =
  | Readonly<{
      _tag: "Pending";
      acceptedAt: DateTime.Utc;
      minimumPollIntervalSeconds: number;
    }>
  | Readonly<{ _tag: "Consume" }>
  | Readonly<{
      _tag: "WrongVerifier";
      wrongVerifierAttempts: number;
      lifecycle: "pending_approval" | "ready" | "invalidated";
    }>
  | Readonly<{
      _tag: "SlowDown";
      minimumPollIntervalSeconds: number;
      retryAfterSeconds: number;
    }>
  | Readonly<{ _tag: "Expired" }>
  | Readonly<{ _tag: "Invalid" }>;

/** Closed outcome for a proof check that deliberately excludes polling cadence and redemption. */
export type PendingBrowserLoginProofDecision =
  | Readonly<{ _tag: "Accept" }>
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Expired" }>
  | Readonly<{
      _tag: "WrongVerifier";
      wrongVerifierAttempts: number;
      lifecycle: "pending_approval" | "invalidated";
    }>;

/** Pending pairing state and independent browser proof at the mailbox approval boundary. */
export type PendingBrowserLoginProofInput = Readonly<{
  lifecycle: BrowserLoginPairingLifecycle;
  verifierMatches: boolean;
  wrongVerifierAttempts: number;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

const normalizePublicCodeText = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();
  if (browserLoginPublicCodePattern.test(upper)) return upper;
  return browserLoginPublicCodeSymbolsPattern.test(upper)
    ? `${upper.slice(0, 4)}-${upper.slice(4)}`
    : upper;
};

/** Public decoder with narrow ASCII presentation normalization and canonical encoding. */
export const BrowserLoginPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    BrowserLoginPublicCode,
    SchemaTransformation.transform({
      decode: normalizePublicCodeText,
      encode: (code) => code,
    })
  )
);

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

/** Shared terminal threshold for wrong private-verifier attempts against one pairing. */
export const maximumWrongVerifierAttempts = 5;
