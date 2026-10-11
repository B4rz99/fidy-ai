import { BigDecimal, DateTime, Option } from "effect";
import type { CanonicalInput } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import type { Category, Transaction } from "./presentation";

export type CorrectionDraft = Readonly<{
  amount: string;
  counterparty: string;
  notes: string;
  date: string;
  direction: Transaction["direction"];
  categoryId: string;
}>;
export type CorrectionDraftContext = Readonly<{
  transaction: Transaction;
  categories: ReadonlyArray<Category>;
  timeZone: string;
}>;
const localDate = (transaction: Transaction, timeZone: string): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
  );
export const initialCorrectionDraft = ({
  transaction,
  timeZone,
}: Pick<CorrectionDraftContext, "transaction" | "timeZone">): CorrectionDraft => ({
  amount: BigDecimal.format(transaction.money.amount),
  counterparty: Option.getOrElse(transaction.counterparty, () => ""),
  notes: Option.getOrElse(transaction.notes, () => ""),
  date: localDate(transaction, timeZone),
  direction: transaction.direction,
  categoryId: transaction.categoryId,
});
type CorrectionChanges = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
const textChanges = (draft: CorrectionDraft, original: CorrectionDraft): CorrectionChanges => ({
  ...(draft.counterparty !== original.counterparty
    ? { counterparty: draft.counterparty.trim() || null }
    : {}),
  ...(draft.notes !== original.notes ? { notes: draft.notes.trim() || null } : {}),
  ...(draft.direction !== original.direction ? { direction: draft.direction } : {}),
});
const parseAmount = (text: string): Option.Option<BigDecimal.BigDecimal> =>
  BigDecimal.fromString(text.trim().replace(",", ".")).pipe(Option.filter(BigDecimal.isPositive));
const parseDate = (draft: CorrectionDraft, timeZone: string): Option.Option<DateTime.Zoned> =>
  DateTime.makeZoned(`${draft.date}T00:00:00.000Z`, { timeZone, adjustForTimeZone: true }).pipe(
    Option.filter((date) => DateTime.formatIsoDate(date) === draft.date)
  );
export const correctionChanges = ({
  draft,
  context: props,
}: Readonly<{
  draft: CorrectionDraft;
  context: CorrectionDraftContext;
}>): Option.Option<CorrectionChanges> => {
  const amount = parseAmount(draft.amount);
  const occurredAt = parseDate(draft, props.timeZone);
  const category = Option.fromNullishOr(
    props.categories.find((item) => item.id === draft.categoryId)
  );
  if (Option.isNone(amount) || Option.isNone(occurredAt) || Option.isNone(category)) {
    return Option.none();
  }
  const original = initialCorrectionDraft(props);
  const changes: CorrectionChanges = {
    ...textChanges(draft, original),
    ...(BigDecimal.Order(amount.value, props.transaction.money.amount) !== 0
      ? { money: { amount: amount.value, currency: props.transaction.money.currency } }
      : {}),
    ...(draft.categoryId !== original.categoryId ? { categoryId: category.value.id } : {}),
    ...(draft.date !== original.date ? { occurredAt: DateTime.toUtc(occurredAt.value) } : {}),
  };
  return isCanonicalInput("transactions.updateTransaction", {
    params: { id: props.transaction.id },
    payload: { expectedRevision: props.transaction.revision, changes },
  })
    ? Option.some(changes)
    : Option.none();
};
