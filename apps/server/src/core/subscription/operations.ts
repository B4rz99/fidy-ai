import { BigDecimal, Data, DateTime, Effect, Function, Option } from "effect";
import { type ReadonlyMoney, encodeMoneyAmount } from "~/core/_shared/money";
import type { IanaTimeZone } from "~/core/_shared/context";
import { type BillingPeriod, type PriceId } from "./contract";

export const refundMinorUnits = (money: ReadonlyMoney): Option.Option<number> => {
  if (money.currency !== "COP" || BigDecimal.Order(money.amount, BigDecimal.make(0n, 0)) <= 0) {
    return Option.none();
  }

  const [whole = "0", fraction = ""] = encodeMoneyAmount(money.amount).split(".");
  const providerFractionDigits = 2;

  if (fraction.length > providerFractionDigits) return Option.none();
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(providerFractionDigits, "0"));

  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Option.some(Number(cents)) : Option.none();
};

export type PaidPeriodWindow = Readonly<{
  startsAt: DateTime.Utc;
  endsAt: DateTime.Utc;
  renewalAnchor: DateTime.Utc;
}>;

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

export const renewalPeriod = (
  input: Readonly<{
    billingPeriod: BillingPeriod;
    timeZone: IanaTimeZone;
    originalStartsAt: DateTime.Utc;
    previousEndsAt: DateTime.Utc;
  }>
): Effect.Effect<PaidPeriodWindow> => {
  if (input.billingPeriod === "weekly") {
    return paidPeriodFor("weekly", input.timeZone, input.previousEndsAt);
  }

  const zone = DateTime.zoneMakeNamedUnsafe(input.timeZone);
  const original = DateTime.setZone(input.originalStartsAt, zone);
  const start = DateTime.toParts(original);
  const boundary = DateTime.toParts(DateTime.setZone(input.previousEndsAt, zone));
  const years = boundary.year - start.year;
  const monthsPerYear = 12;

  const end = DateTime.add(
    original,
    input.billingPeriod === "monthly"
      ? { months: years * monthsPerYear + boundary.month - start.month + 1 }
      : { years: years + 1 }
  );

  const endsAt = DateTime.toUtc(end);

  return Effect.succeed({ startsAt: input.previousEndsAt, endsAt, renewalAnchor: endsAt });
};

export type EnrollmentCheckpoint =
  | Readonly<{ status: "prepared"; priceId: PriceId; expiresAt: DateTime.Utc }>
  | Readonly<{
      status: "creating" | "available" | "refused" | "expired" | "verifying";
      priceId: PriceId;
    }>;

export type EnrollmentSubmissionDecision = Data.TaggedEnum<{
  BeginSubmission: {};
  RecordExpiration: {};
  ReturnCurrentStatus: {};
}>;

export const EnrollmentSubmissionDecision = Data.taggedEnum<EnrollmentSubmissionDecision>();

export type EnrollmentPreparationDecision = Data.TaggedEnum<{
  Observe: {};
  ReplaceIntent: {};
  ReauthorizeSource: {};
  RestartRequired: {};
}>;

export const EnrollmentPreparationDecision = Data.taggedEnum<EnrollmentPreparationDecision>();

export const decideEnrollmentSubmission: {
  (now: DateTime.Utc): (checkpoint: EnrollmentCheckpoint) => EnrollmentSubmissionDecision;
  (checkpoint: EnrollmentCheckpoint, now: DateTime.Utc): EnrollmentSubmissionDecision;
} = Function.dual(
  2,
  (checkpoint: EnrollmentCheckpoint, now: DateTime.Utc): EnrollmentSubmissionDecision => {
    if (checkpoint.status !== "prepared") return EnrollmentSubmissionDecision.ReturnCurrentStatus();

    return DateTime.Order(now, checkpoint.expiresAt) < 0
      ? EnrollmentSubmissionDecision.BeginSubmission()
      : EnrollmentSubmissionDecision.RecordExpiration();
  }
);

export const decideEnrollmentPreparation: {
  (
    requestedPriceId: PriceId
  ): (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>
  ) => EnrollmentPreparationDecision;
  (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>,
    requestedPriceId: PriceId
  ): EnrollmentPreparationDecision;
} = Function.dual(
  2,
  (
    checkpoint: Readonly<Pick<EnrollmentCheckpoint, "status" | "priceId">>,
    requestedPriceId: PriceId
  ): EnrollmentPreparationDecision => {
    if (checkpoint.status === "refused" || checkpoint.status === "expired") {
      return EnrollmentPreparationDecision.RestartRequired();
    }

    if (checkpoint.priceId === requestedPriceId) return EnrollmentPreparationDecision.Observe();

    if (checkpoint.status === "prepared") return EnrollmentPreparationDecision.ReplaceIntent();

    if (checkpoint.status === "available") return EnrollmentPreparationDecision.ReauthorizeSource();

    return EnrollmentPreparationDecision.Observe();
  }
);
