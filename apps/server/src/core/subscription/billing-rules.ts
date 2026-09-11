import { type BigDecimal, DateTime, Effect, Function } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import { encodeMoneyAmount } from "~/core/_shared/money";
import type { BillingPeriod, WompiBillingStatus } from "./model";

/** Converts validated two-decimal billing Money to Wompi's exact integer minor unit. */
export const amountInCentsForBilling = (
  amount: Readonly<BigDecimal.BigDecimal>
): Effect.Effect<number> => {
  const [whole = "0", fraction = ""] = encodeMoneyAmount(amount).split(".");
  return Effect.succeed(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
};

/** Persisted lifecycle of one BillingAttempt. */
export type BillingAttemptStatus = "pending" | "failed" | "succeeded";

const settlementOutcome: Readonly<
  Record<BillingAttemptStatus, Readonly<Record<WompiBillingStatus, BillingAttemptStatus>>>
> = {
  pending: {
    PENDING: "pending",
    APPROVED: "succeeded",
    DECLINED: "failed",
    VOIDED: "failed",
    ERROR: "failed",
  },
  failed: {
    PENDING: "failed",
    APPROVED: "succeeded",
    DECLINED: "failed",
    VOIDED: "failed",
    ERROR: "failed",
  },
  succeeded: {
    PENDING: "succeeded",
    APPROVED: "succeeded",
    DECLINED: "succeeded",
    VOIDED: "succeeded",
    ERROR: "succeeded",
  },
};

/** Advances settlement monotonically without allowing later evidence to downgrade success. */
export const decideBillingAttemptOutcome = (
  input: Readonly<{
    current: BillingAttemptStatus;
    observed: WompiBillingStatus;
  }>
): Effect.Effect<BillingAttemptStatus> =>
  Effect.succeed(settlementOutcome[input.current][input.observed]);

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
