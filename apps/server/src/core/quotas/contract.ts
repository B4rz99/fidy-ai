import { Schema } from "effect";
import { AccessTier } from "~/core/access-tier/contract";

export const AllowanceKind = Schema.Literals([
  "forwarded_email",
  "media_submission",
  "hosted_history_turn",
  "canonical_call",
]);

export type AllowanceKind = typeof AllowanceKind.Type;

export const freeAllowanceLimits: Readonly<Record<AllowanceKind, number>> = {
  forwarded_email: 30,
  media_submission: 2,
  hosted_history_turn: 2,
  canonical_call: 50,
};

export const AllowancePeriod = Schema.Struct({
  startsAt: Schema.DateTimeUtc,
  resetsAt: Schema.DateTimeUtc,
});

export type AllowancePeriod = typeof AllowancePeriod.Type;

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

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

export const QuotaStatus = Schema.Struct({
  accessTier: AccessTier,
  forwardedEmails: AllowanceMeter,
  mediaSubmissions: AllowanceMeter,
  hostedHistoryTurns: AllowanceMeter,
  canonicalCalls: AllowanceMeter,
});

export type QuotaStatus = typeof QuotaStatus.Type;

const maximumRetryKeyLength = 128;

export const CanonicalRetryKey = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumRetryKeyLength),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/u)
)
  .pipe(Schema.brand("CanonicalRetryKey"))
  .annotate({ identifier: "CanonicalRetryKey" });

export type CanonicalRetryKey = typeof CanonicalRetryKey.Type;

export const canonicalRetryLifetimeMs = 86_400_000;
