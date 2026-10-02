import { DateTime, Effect, Function } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import { type BillingPeriod, type PriceId } from "./contract";

/** Calendar paid-period facts derived from verified settlement in the captured named time zone. */
export type PaidPeriodWindow = Readonly<{
  startsAt: DateTime.Utc;
  endsAt: DateTime.Utc;
  renewalAnchor: DateTime.Utc;
}>;

/** Derives a calendar period from verified finalization in the captured named time zone. */
export const paidPeriodFor: {
  (
    timeZone: IanaTimeZone,
    finalizedAt: DateTime.Utc
  ): (billingPeriod: BillingPeriod) => Effect.Effect<PaidPeriodWindow>;
  (
    billingPeriod: BillingPeriod,
    timeZone: IanaTimeZone,
    finalizedAt: DateTime.Utc
  ): Effect.Effect<PaidPeriodWindow>;
} = Function.dual(
  3,
  (billingPeriod: BillingPeriod, timeZone: IanaTimeZone, finalizedAt: DateTime.Utc) => {
    const zonedStart = DateTime.setZone(finalizedAt, DateTime.zoneMakeNamedUnsafe(timeZone));
    let zonedEnd: DateTime.Zoned;
    if (billingPeriod === "weekly") {
      zonedEnd = DateTime.add(zonedStart, { weeks: 1 });
    } else if (billingPeriod === "monthly") {
      zonedEnd = DateTime.add(zonedStart, { months: 1 });
    } else {
      zonedEnd = DateTime.add(zonedStart, { years: 1 });
    }
    const endsAt = DateTime.toUtc(zonedEnd);
    return Effect.succeed({ startsAt: finalizedAt, endsAt, renewalAnchor: endsAt });
  }
);

/**
 * Persisted enrollment lifecycle: prepared waits for submission; creating has been claimed;
 * available has a reusable payment source; refused is a definitive provider rejection; expired
 * exceeded its preparation window; verifying awaits operator resolution of an uncertain outcome.
 */
export type EnrollmentCheckpoint =
  | Readonly<{ status: "prepared"; priceId: PriceId; expiresAt: DateTime.Utc }>
  | Readonly<{
      status: "creating" | "available" | "refused" | "expired" | "verifying";
      priceId: PriceId;
    }>;

/** Closed action for one replay-safe submission attempt. */
export const decideEnrollmentSubmission: {
  (
    now: DateTime.Utc
  ): (
    checkpoint: EnrollmentCheckpoint
  ) => Readonly<{ _tag: "BeginSubmission" | "RecordExpiration" | "ReturnCurrentStatus" }>;
  (
    checkpoint: EnrollmentCheckpoint,
    now: DateTime.Utc
  ): Readonly<{ _tag: "BeginSubmission" | "RecordExpiration" | "ReturnCurrentStatus" }>;
} = Function.dual(
  2,
  (
    checkpoint: EnrollmentCheckpoint,
    now: DateTime.Utc
  ): Readonly<{ _tag: "BeginSubmission" | "RecordExpiration" | "ReturnCurrentStatus" }> => {
    if (checkpoint.status !== "prepared") return { _tag: "ReturnCurrentStatus" };
    return DateTime.Order(now, checkpoint.expiresAt) < 0
      ? { _tag: "BeginSubmission" }
      : { _tag: "RecordExpiration" };
  }
);

/** Decides whether Price selection can reuse an intent or an already-available source. */
export const decideEnrollmentPreparation: {
  (requestedPriceId: PriceId): (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>
  ) => Readonly<{
    _tag: "Observe" | "ReplaceIntent" | "ReauthorizeSource" | "RestartRequired";
  }>;
  (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>,
    requestedPriceId: PriceId
  ): Readonly<{
    _tag: "Observe" | "ReplaceIntent" | "ReauthorizeSource" | "RestartRequired";
  }>;
} = Function.dual(
  2,
  (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>,
    requestedPriceId: PriceId
  ): Readonly<{
    _tag: "Observe" | "ReplaceIntent" | "ReauthorizeSource" | "RestartRequired";
  }> => {
    if (checkpoint.status === "refused" || checkpoint.status === "expired") {
      return { _tag: "RestartRequired" };
    }
    if (checkpoint.priceId === requestedPriceId) return { _tag: "Observe" };
    if (checkpoint.status === "prepared") return { _tag: "ReplaceIntent" };
    if (checkpoint.status === "available") return { _tag: "ReauthorizeSource" };
    return { _tag: "Observe" };
  }
);
