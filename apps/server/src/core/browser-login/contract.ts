import { Data, type DateTime, type Option, Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

export const BrowserLoginPairingId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserLoginPairingId"))
  .annotate({ identifier: "BrowserLoginPairingId" });

export type BrowserLoginPairingId = typeof BrowserLoginPairingId.Type;

export const browserLoginPollingIntervalSeconds = 5;

export const browserLoginPublicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" as const;

const browserLoginPublicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;

const browserLoginPublicCodeSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

export const BrowserLoginPublicCode = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodePattern)
)
  .pipe(Schema.brand("BrowserLoginPublicCode"))
  .annotate({ identifier: "BrowserLoginPublicCode" });

export type BrowserLoginPublicCode = typeof BrowserLoginPublicCode.Type;

export const browserLoginPairingLifetime = "10 minutes" as const;

export const BrowserLoginPublicCodeSymbols = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodeSymbolsPattern)
).pipe(Schema.brand("BrowserLoginPublicCodeSymbols"));

export type BrowserLoginPublicCodeSymbols = typeof BrowserLoginPublicCodeSymbols.Type;

export const BrowserLoginPairingLifecycle = Schema.Literals([
  "pending_approval",
  "ready",
  "expired",
  "superseded",
  "consumed",
  "invalidated",
]);

export type BrowserLoginPairingLifecycle = typeof BrowserLoginPairingLifecycle.Type;

export type RedemptionInput = Readonly<{
  lifecycle: BrowserLoginPairingLifecycle;
  verifierMatches: boolean;
  wrongVerifierAttempts: number;
  minimumPollIntervalSeconds: number;
  lastAcceptedPollAt: Option.Option<DateTime.Utc>;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

export type BrowserLoginRedemptionDecision = Data.TaggedEnum<{
  Pending: { readonly acceptedAt: DateTime.Utc; readonly minimumPollIntervalSeconds: number };
  Consume: {};
  WrongVerifier: {
    readonly wrongVerifierAttempts: number;
    readonly lifecycle: "pending_approval" | "ready" | "invalidated";
  };
  SlowDown: { readonly minimumPollIntervalSeconds: number; readonly retryAfterSeconds: number };
  Expired: {};
  Invalid: {};
}>;

export const BrowserLoginRedemptionDecision = Data.taggedEnum<BrowserLoginRedemptionDecision>();

export type PendingBrowserLoginProofDecision = Data.TaggedEnum<{
  Accept: {};
  Invalid: {};
  Expired: {};
  WrongVerifier: {
    readonly wrongVerifierAttempts: number;
    readonly lifecycle: "pending_approval" | "invalidated";
  };
}>;

export const PendingBrowserLoginProofDecision = Data.taggedEnum<PendingBrowserLoginProofDecision>();

export type PendingBrowserLoginProofInput = Readonly<{
  lifecycle: BrowserLoginPairingLifecycle;
  verifierMatches: boolean;
  wrongVerifierAttempts: number;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

const normalizePublicCodeText = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();

  return browserLoginPublicCodeSymbolsPattern.test(upper)
    ? `${upper.slice(0, 4)}-${upper.slice(4)}`
    : upper;
};

export const BrowserLoginPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    BrowserLoginPublicCode,
    SchemaTransformation.transform({
      decode: normalizePublicCodeText,
      encode: (code) => code,
    })
  )
);

export const BrowserLoginPrivateVerifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)
)
  .pipe(Schema.brand("BrowserLoginPrivateVerifier"))
  .annotate({ identifier: "BrowserLoginPrivateVerifier" });

export type BrowserLoginPrivateVerifier = typeof BrowserLoginPrivateVerifier.Type;

export const StartedBrowserLoginPairing = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.RedactedFromValue(BrowserLoginPrivateVerifier),
  publicCode: BrowserLoginPublicCode,
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Literal(browserLoginPollingIntervalSeconds),
}).annotate({ identifier: "StartedBrowserLoginPairing" });

export type StartedBrowserLoginPairing = typeof StartedBrowserLoginPairing.Type;

export const maximumWrongVerifierAttempts = 5;
