import { Array as Arr, BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import { browserCrypto } from "@/browser/crypto";
import { AtomicBatchCallId, type CanonicalInput } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import type { Category, Transaction } from "./presentation";

export type BulkDraft = Readonly<{
  categoryId: string;
  direction: string;
  counterparty: string;
  notes: string;
  amount: string;
  date: string;
}>;
export type BatchInput = CanonicalInput<"operations.executeAtomicBatch">;
type Changes = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
export type BulkDraftContext = Readonly<{
  transactions: Arr.NonEmptyReadonlyArray<Transaction>;
  categories: ReadonlyArray<Category>;
  timeZone: string;
}>;
const draftFacts = (draft: BulkDraft, props: BulkDraftContext): Changes => ({
  ...Option.match(
    Option.fromNullishOr(props.categories.find((category) => category.id === draft.categoryId)),
    { onNone: () => ({}), onSome: (category) => ({ categoryId: category.id }) }
  ),
  ...(draft.direction === "inflow" || draft.direction === "outflow"
    ? { direction: draft.direction }
    : {}),
  ...(draft.counterparty.trim() !== "" ? { counterparty: draft.counterparty.trim() } : {}),
  ...(draft.notes.trim() !== "" ? { notes: draft.notes.trim() } : {}),
});
const draftMoney = (draft: BulkDraft, props: BulkDraftContext): Option.Option<Changes> => {
  if (draft.amount === "") return Option.some({});
  const first = Option.fromNullishOr(props.transactions[0]);
  if (
    Option.isNone(first) ||
    new Set(props.transactions.map((record) => record.money.currency)).size !== 1
  ) {
    return Option.none();
  }
  return BigDecimal.fromString(draft.amount.replace(",", ".")).pipe(
    Option.filter(BigDecimal.isPositive),
    Option.map((amount) => ({ money: { amount, currency: first.value.money.currency } }))
  );
};
const draftDate = (draft: BulkDraft, timeZone: string): Option.Option<Changes> => {
  if (draft.date === "") return Option.some({});
  return DateTime.makeZoned(`${draft.date}T00:00:00.000Z`, {
    timeZone,
    adjustForTimeZone: true,
  }).pipe(
    Option.filter((value) => DateTime.formatIsoDate(value) === draft.date),
    Option.map((value) => ({ occurredAt: DateTime.toUtc(value) }))
  );
};
export const bulkDraftChanges = ({
  draft,
  context: props,
}: Readonly<{ draft: BulkDraft; context: BulkDraftContext }>): Option.Option<Changes> =>
  Option.all({ money: draftMoney(draft, props), date: draftDate(draft, props.timeZone) }).pipe(
    Option.map(({ money, date }) => ({ ...draftFacts(draft, props), ...money, ...date }))
  );
export const bulkBatchInput = ({
  changes,
  transactions,
}: Readonly<{
  changes: Changes;
  transactions: ReadonlyArray<Pick<Transaction, "id" | "revision">>;
}>): Option.Option<BatchInput> => {
  const calls = transactions.map((record) => ({
    callId: Schema.decodeSync(AtomicBatchCallId)(
      Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie))
    ),
    operation: "transactions.updateTransaction",
    input: { params: { id: record.id }, payload: { expectedRevision: record.revision, changes } },
  }));
  if (
    !Arr.isReadonlyArrayNonEmpty(calls) ||
    !calls.every((call) => isCanonicalInput("transactions.updateTransaction", call.input))
  ) {
    return Option.none();
  }
  const input = { payload: { calls } };
  return isCanonicalInput("operations.executeAtomicBatch", input)
    ? Option.some(input)
    : Option.none();
};
