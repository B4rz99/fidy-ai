import { type BigDecimal, DateTime, Duration, Effect, Option } from "effect";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { type WompiBillingStatus } from "./wompi-model";

export const amountInCentsForBilling = (
  amount: Readonly<BigDecimal.BigDecimal>
): Effect.Effect<number> => {
  const [whole = "0", fraction = ""] = encodeMoneyAmount(amount).split(".");

  return Effect.succeed(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
};

export type BillingAttemptStatus = "pending" | "failed" | "succeeded";

export const wompiRetryOpportunity = Duration.minutes(3);

export type BillingTransactionFact = Readonly<{
  status: Option.Option<WompiBillingStatus>;
  firstObservedAt: DateTime.Utc;
  negativeObservedAt: Option.Option<DateTime.Utc>;
  finalizedAt: Option.Option<DateTime.Utc>;
}>;

const terminalNegativeStatuses: Readonly<Record<WompiBillingStatus, boolean>> = {
  PENDING: false,
  APPROVED: false,
  DECLINED: true,
  VOIDED: true,
  ERROR: true,
};

export const approvingFinalizedAtFor = (
  transactions: ReadonlyArray<BillingTransactionFact>
): Effect.Effect<Option.Option<DateTime.Utc>> => {
  const approving = transactions.find(
    (transaction) =>
      Option.contains(transaction.status, "APPROVED") && Option.isSome(transaction.finalizedAt)
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

  if (
    input.transactions.some(
      (transaction) =>
        Option.contains(transaction.status, "APPROVED") && Option.isSome(transaction.finalizedAt)
    )
  ) {
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

export const decideBillingAttemptOutcome = (
  input: BillingAttemptOutcomeInput
): Effect.Effect<BillingAttemptStatus> => Effect.succeed(nextBillingAttemptOutcome(input));
