import { BigDecimal, Effect, Option, Schema } from "effect";
import {
  type RecurringCommand,
  RecurringDocument,
  type RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import {
  readRecurringOccurrence,
  validAssociation,
} from "../../../src/core/recurring-plans/operations";
import {
  type CanonicalPreparationWork,
  type OwnerOutcome,
} from "../../canonical-operations/contract";

import { ownsRecurringSeries } from "../../recurring/operations";
import { listCategories } from "../../categories/operations";
import { readPlanningTransactions } from "../../transactions/operations";
import { readDocument } from "./store";

import { planningFact } from "./facts";
import { displayDocument } from "./display";

const operation = "recurringPlans.applyRecurringEdit";
export const validateReferences = ({
  work,
  command,
  document,
}: Readonly<{
  work: CanonicalPreparationWork;
  command: RecurringCommand;
  document: RecurringDocument;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* validPlanReferences({ work, document }))) return false;
    if (!(yield* validSeriesReference({ work, command }))) return false;
    return yield* validFinancialReference({ work, command, document });
  }).pipe(Effect.orElseSucceed(() => false));
const validFinancialReference = ({
  work,
  command,
  document,
}: Readonly<{
  work: CanonicalPreparationWork;
  command: RecurringCommand;
  document: RecurringDocument;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (command.edit.kind !== "fulfill" || command.edit.fulfillment.transactionId === undefined) {
      return true;
    }
    const mark = command.edit.fulfillment;
    const selected = yield* readPlanningTransactions({
      db: work.db,
      userId: work.subject.userId,
      selection: { kind: "ids", ids: [command.edit.fulfillment.transactionId] },
    });
    const transaction = Option.isSome(selected) ? selected.value.transactions[0] : undefined;
    const item = readRecurringOccurrence({ document, planId: mark.planId, date: mark.date });
    if (transaction === undefined || Option.isNone(item)) return false;
    const fact = planningFact({ transaction, timeZone: item.value.plan.timeZone });
    return (
      validAssociation({ plan: item.value.plan, fact }) &&
      fact.date === mark.actualDate &&
      BigDecimal.equals(fact.money.amount, mark.money.amount)
    );
  }).pipe(Effect.orElseSucceed(() => false));

const validPlanReferences = ({
  work,
  document,
}: Readonly<{
  work: CanonicalPreparationWork;
  document: RecurringDocument;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const plans = [
      ...document.plans.flatMap((plan) => plan.revisions.map((entry) => entry.plan)),
      ...document.exceptions.flatMap((entry) =>
        entry.replacement === undefined ? [] : [entry.replacement]
      ),
    ];
    const categories = yield* listCategories({ db: work.db }).pipe(Effect.orElseSucceed(() => []));
    return plans.every((plan) =>
      validPlanReference(
        plan,
        categories.map((category) => category.id)
      )
    );
  });
const validPlanReference = (
  plan: RecurringPlanInput,
  categories: ReadonlyArray<string>
): boolean => {
  if (plan.accountId !== undefined) return false;
  return plan.categoryId === undefined || categories.includes(plan.categoryId);
};
export const validReversal = ({
  work,
  command,
  document,
}: Readonly<{
  work: CanonicalPreparationWork;
  command: RecurringCommand;
  document: RecurringDocument;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (command.edit.kind !== "reverse") return true;
    const id = command.edit.fulfillmentId;
    if (document.fulfillments.some((mark) => mark.id === id)) return true;
    const selected = yield* readPlanningTransactions({
      db: work.db,
      userId: work.subject.userId,
      selection: { kind: "ids", ids: [command.edit.fulfillmentId] },
    });
    return Option.isSome(selected) && selected.value.transactions.length === 1;
  });
const validSeriesReference = ({
  work,
  command,
}: Readonly<{
  work: CanonicalPreparationWork;
  command: RecurringCommand;
}>): Effect.Effect<boolean> => {
  const edit = command.edit;
  if (edit.kind !== "create" && edit.kind !== "suggestion") return Effect.succeed(true);
  if (edit.seriesId === undefined) return Effect.succeed(true);
  return ownsRecurringSeries({ db: work.db, userId: work.subject.userId, seriesId: edit.seriesId });
};
export const outcome = (compact: boolean): OwnerOutcome => ({
  _tag: "Owner",
  operation,
  collisionKey: Option.some("recurring-plan-document"),
  guardFacts: Option.none(),
  read: (db, userId) =>
    readDocument({ db, userId }).pipe(
      Effect.map((document) => displayDocument({ document, compact })),
      Effect.map((document) =>
        Option.some({
          _tag: "Owner" as const,
          payload: document,
          encode: () => Schema.encodeEffect(Schema.toCodecJson(RecurringDocument))(document),
        })
      ),
      Effect.orElseSucceed(() => Option.none())
    ),
});
