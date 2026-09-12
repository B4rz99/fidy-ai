import { type BigDecimal, DateTime, Duration, Effect, Function, Option } from "effect";
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

/** Wompi's documented retry opportunity after a failed payment under one checkout reference. */
export const wompiRetryOpportunity = Duration.minutes(3);

/** One retained provider transaction contributing to a BillingAttempt's aggregate outcome. */
export type BillingTransactionFact = Readonly<{
  status: WompiBillingStatus;
  firstObservedAt: DateTime.Utc;
  finalizedAt: Option.Option<DateTime.Utc>;
}>;

/** Complete status classification, so a new provider status cannot silently read as a decline. */
const terminalNegativeStatuses: Readonly<Record<WompiBillingStatus, boolean>> = {
  PENDING: false,
  APPROVED: false,
  DECLINED: true,
  VOIDED: true,
  ERROR: true,
};

/**
 * The first retained approval anchors the paid period. Settlement requires its finalization, so an
 * approval without one is inconsistent evidence rather than an anchor.
 */
export const approvingFinalizedAtFor = (
  transactions: ReadonlyArray<BillingTransactionFact>
): Effect.Effect<Option.Option<DateTime.Utc>> => {
  const approving = transactions.find((transaction) => transaction.status === "APPROVED");
  return Effect.succeed(approving === undefined ? Option.none() : approving.finalizedAt);
};

type BillingTransactionStatusInput = Readonly<{
  current: Option.Option<WompiBillingStatus>;
  observed: WompiBillingStatus;
}>;

const nextTransactionStatus = (input: BillingTransactionStatusInput): WompiBillingStatus => {
  if (input.observed === "APPROVED") return "APPROVED";
  if (Option.isSome(input.current)) {
    if (input.current.value === "APPROVED") return "APPROVED";
    if (terminalNegativeStatuses[input.current.value]) return input.current.value;
  }
  return input.observed;
};

/** Advances one provider transaction monotonically; approval absorbs and terminal states stay final. */
export const decideBillingTransactionStatus = (
  input: BillingTransactionStatusInput
): Effect.Effect<WompiBillingStatus> => Effect.succeed(nextTransactionStatus(input));

type BillingAttemptOutcomeInput = Readonly<{
  current: BillingAttemptStatus;
  transactions: ReadonlyArray<BillingTransactionFact>;
  observedAt: DateTime.Utc;
}>;

const nextBillingAttemptOutcome = (input: BillingAttemptOutcomeInput): BillingAttemptStatus => {
  if (input.current === "succeeded") return "succeeded";
  if (input.transactions.some((transaction) => transaction.status === "APPROVED")) {
    return "succeeded";
  }
  if (input.current === "failed") return "failed";
  if (input.transactions.length === 0) return "pending";
  if (!input.transactions.every((transaction) => terminalNegativeStatuses[transaction.status])) {
    return "pending";
  }
  const earliest = input.transactions
    .map((transaction) => transaction.firstObservedAt)
    .reduce((candidate, observedAt) => DateTime.min(candidate, observedAt));
  const elapsed = DateTime.distance(earliest, input.observedAt);
  return Duration.toMillis(elapsed) >= Duration.toMillis(wompiRetryOpportunity)
    ? "failed"
    : "pending";
};

/**
 * Aggregates every retained provider transaction into the BillingAttempt's next state. One verified
 * approval succeeds the attempt; an unresolved transaction keeps it pending; observed final
 * negatives fail it only after Wompi's retry opportunity elapses. Without any observed transaction
 * there is no failure evidence, and `failed` never returns to `pending`.
 */
export const decideBillingAttemptOutcome = (
  input: BillingAttemptOutcomeInput
): Effect.Effect<BillingAttemptStatus> => Effect.succeed(nextBillingAttemptOutcome(input));

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
