import { DateTime, Effect, Option } from "effect";
import {
  type RecurringDocument,
  type RecurringMatchFact,
  type RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import type { Transaction } from "../../../src/core/transactions/contract";
import { readPlanningTransactions } from "../../transactions/operations";
import { RecurringPlanningUnavailable } from "../contract";

export const planningFact = ({
  transaction,
  timeZone,
}: Readonly<{
  transaction: Transaction;
  timeZone: RecurringPlanInput["timeZone"];
}>): RecurringMatchFact => ({
  id: transaction.id,
  money: transaction.money,
  direction: transaction.direction,
  date: DateTime.formatIsoDate(DateTime.makeZonedUnsafe(transaction.occurredAt, { timeZone })),
  categoryId: transaction.categoryId,
  ...(Option.isSome(transaction.counterparty)
    ? { counterparty: transaction.counterparty.value }
    : {}),
});
export const linkedTransactionIds = (document: RecurringDocument): ReadonlyArray<string> => [
  ...new Set(
    document.fulfillments.flatMap((mark) =>
      mark.transactionId === undefined ? [] : [mark.transactionId]
    )
  ),
];

export const linkedTransactions = ({
  db,
  userId,
  document,
}: Readonly<{ db: D1Database; userId: string; document: RecurringDocument }>): Effect.Effect<
  ReadonlyArray<Transaction>,
  RecurringPlanningUnavailable
> =>
  Effect.gen(function* () {
    const ids = linkedTransactionIds(document);
    const size = 128;
    const transactions: Transaction[] = [];
    for (let index = 0; index < ids.length; index += size) {
      const page = yield* readPlanningTransactions({
        db,
        userId,
        selection: { kind: "ids", ids: ids.slice(index, index + size) },
      });
      if (Option.isNone(page) || !page.value.complete) {
        return yield* new RecurringPlanningUnavailable();
      }
      transactions.push(...page.value.transactions);
    }
    return transactions;
  });
