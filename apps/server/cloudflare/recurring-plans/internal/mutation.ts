import type { Transaction } from "../../../src/core/transactions/contract";
import { BigDecimal, Option } from "effect";
import {
  type RecurringDocument,
  type RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import {
  readRecurringOccurrence,
  validAssociation,
} from "../../../src/core/recurring-plans/operations";

import { planningFact } from "./facts";

export const validLinkedFulfillment = ({
  document,
  mark,
  transaction,
}: {
  document: RecurringDocument;
  mark: RecurringDocument["fulfillments"][number];
  transaction: Option.Option<Transaction>;
}): boolean => {
  const item = readRecurringOccurrence({ document, planId: mark.planId, date: mark.date });

  if (Option.isNone(transaction) || Option.isNone(item)) return false;
  const fact = planningFact({ transaction: transaction.value, timeZone: item.value.plan.timeZone });

  return (
    validAssociation({ plan: item.value.plan, fact }) &&
    fact.date === mark.actualDate &&
    BigDecimal.equals(fact.money.amount, mark.money.amount)
  );
};

export const validPlanCategories = ({
  document,
  categories,
}: {
  document: RecurringDocument;
  categories: ReadonlyArray<string>;
}): boolean => {
  const plans = [
    ...document.plans.flatMap((plan) => plan.revisions.map((entry) => entry.plan)),
    ...document.exceptions.flatMap((entry) =>
      entry.replacement === undefined ? [] : [entry.replacement]
    ),
  ];

  return plans.every((plan) => validPlanReference(plan, categories));
};

const validPlanReference = (
  plan: RecurringPlanInput,
  categories: ReadonlyArray<string>
): boolean => {
  if (plan.accountId !== undefined) return false;

  return plan.categoryId === undefined || categories.includes(plan.categoryId);
};
