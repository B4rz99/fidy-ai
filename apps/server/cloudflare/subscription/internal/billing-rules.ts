import { type BigDecimal, DateTime, Duration, Effect, Option } from "effect";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { type WompiBillingStatus } from "./wompi-model";

/** Converts validated two-decimal billing Money to Wompi's exact integer minor unit. */
export const amountInCentsForBilling = (
  amount: Readonly<BigDecimal.BigDecimal>
): Effect.Effect<number> => {
  const [whole = "0", fraction = ""] = encodeMoneyAmount(amount).split(".");
  return Effect.succeed(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
};

export type BillingAttemptStatus = "pending" | "failed" | "succeeded";

/** Wompi's documented retry opportunity after a failed payment under one checkout reference. */
export const wompiRetryOpportunity = Duration.minutes(3);

/** One retained provider transaction contributing to a BillingAttempt's aggregate outcome. */
export type BillingTransactionFact = Readonly<{
  status: Option.Option<WompiBillingStatus>;
  firstObservedAt: DateTime.Utc;
  negativeObservedAt: Option.Option<DateTime.Utc>;
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
  const approving = transactions.find((transaction) =>
    Option.contains(transaction.status, "APPROVED")
  );
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
  if (input.transactions.some((transaction) => Option.contains(transaction.status, "APPROVED"))) {
    return "succeeded";
  }
  if (input.current === "failed") return "failed";
  if (input.transactions.length === 0) return "pending";
  if (
    !input.transactions.every(
      (transaction) =>
        Option.isSome(transaction.status) && terminalNegativeStatuses[transaction.status.value]
    )
  ) {
    return "pending";
  }
  if (input.transactions.some((transaction) => Option.isNone(transaction.negativeObservedAt))) {
    return "pending";
  }
  const earliest = input.transactions
    .flatMap((transaction) => Option.toArray(transaction.negativeObservedAt))
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
