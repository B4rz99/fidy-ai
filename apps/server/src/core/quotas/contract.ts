import { Schema } from "effect";
import { AccessTier } from "../access-tier/contract";

/** Each meter counts one concrete accepted unit; the meters never form a weighted balance. */
export const AllowanceKind = Schema.Literals([
  "forwarded_email",
  "media_submission",
  "hosted_history_turn",
  "canonical_call",
]);
export type AllowanceKind = typeof AllowanceKind.Type;

/** Commercial Free entitlements; security admission policy is independent. */
export const freeAllowanceLimits: Readonly<Record<AllowanceKind, number>> = {
  forwarded_email: 50,
  media_submission: 2,
  hosted_history_turn: 2,
  canonical_call: 50,
};

/** Half-open commercial month in America/Bogota, independent of the User's time zone. */
export const AllowancePeriod = Schema.Struct({
  startsAt: Schema.DateTimeUtc,
  resetsAt: Schema.DateTimeUtc,
});
export type AllowancePeriod = typeof AllowancePeriod.Type;

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Trial/Pro have no visible meter; Free consumption never includes activity performed with Pro access. */
export const AllowanceMeter = Schema.Union([
  Schema.TaggedStruct("Limited", {
    limit: count,
    consumed: count,
    remaining: count,
    period: AllowancePeriod,
  }),
  Schema.TaggedStruct("Uncapped", {}),
]);
export type AllowanceMeter = typeof AllowanceMeter.Type;

/** Current standing for four independent commercial allowances, not security admission capacity. */
export const QuotaStatus = Schema.Struct({
  accessTier: AccessTier,
  forwardedEmails: AllowanceMeter,
  mediaSubmissions: AllowanceMeter,
  hostedHistoryTurns: AllowanceMeter,
  canonicalCalls: AllowanceMeter,
});
export type QuotaStatus = typeof QuotaStatus.Type;

const maximumRetryKeyLength = 128;

/** Non-empty bounded caller retry reference; possession grants no authority. */
export const CanonicalRetryKey = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumRetryKeyLength),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/u)
)
  .pipe(Schema.brand("CanonicalRetryKey"))
  .annotate({ identifier: "CanonicalRetryKey" });
export type CanonicalRetryKey = typeof CanonicalRetryKey.Type;

/** Absolute retry lifetime from first admission; use and month rollover cannot extend it. */
export const canonicalRetryLifetimeMs = 86_400_000;
