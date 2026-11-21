import { DateTime, Option } from "effect";
import {
  type RecurringDocument,
  type RecurringMatchFact,
  type RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import type { Transaction } from "../../../src/core/transactions/contract";

export const planningFact = ({
  transaction,
  timeZone,
}: Readonly<{
  transaction: Transaction;
  timeZone: RecurringPlanInput["timeZone"];
}>): RecurringMatchFact => {
  const fact = {
    id: transaction.id,
    money: transaction.money,
    direction: transaction.direction,
    date: DateTime.formatIsoDate(DateTime.makeZonedUnsafe(transaction.occurredAt, { timeZone })),
    categoryId: transaction.categoryId,
  };

  return Option.match(transaction.counterparty, {
    onNone: () => fact,
    onSome: (counterparty) => ({ ...fact, counterparty }),
  });
};

export const linkedTransactionIds = (
  document: Pick<RecurringDocument, "fulfillments">
): ReadonlyArray<string> => [
  ...new Set(
    document.fulfillments.flatMap((mark) =>
      mark.transactionId === undefined ? [] : [mark.transactionId]
    )
  ),
];
