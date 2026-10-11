import { type Array, Option } from "effect";
import type { CanonicalInput } from "@/transport/client";
import { type EditorDraft } from "./editor-model";
import { bulkDraftChanges } from "./bulk-draft";
import { correctionChanges, initialCorrectionDraft } from "./correction-draft";
import type { Category, Transaction } from "./presentation";

export type EditorContext = Readonly<{
  mode:
    | Readonly<{ _tag: "Single"; transaction: Transaction }>
    | Readonly<{ _tag: "Bulk"; transactions: Array.NonEmptyReadonlyArray<Transaction> }>;
  categories: ReadonlyArray<Category>;
  timeZone: string;
}>;
export type Changes = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
export const editorChanges = ({
  draft,
  context,
}: Readonly<{ draft: EditorDraft; context: EditorContext }>): Option.Option<Changes> => {
  if (context.mode._tag === "Bulk") {
    return bulkDraftChanges({
      draft,
      context: { ...context, transactions: context.mode.transactions },
    });
  }
  if (draft.direction !== "inflow" && draft.direction !== "outflow") return Option.none();
  return correctionChanges({
    draft: { ...draft, direction: draft.direction },
    context: { ...context, transaction: context.mode.transaction },
  });
};
export const initialEditorDraft = (context: EditorContext): EditorDraft =>
  context.mode._tag === "Single"
    ? initialCorrectionDraft({ transaction: context.mode.transaction, timeZone: context.timeZone })
    : { categoryId: "keep", direction: "keep", counterparty: "", notes: "", amount: "", date: "" };
export const mixedEditorCurrencies = (context: EditorContext): boolean =>
  context.mode._tag === "Bulk" &&
  new Set(context.mode.transactions.map((transaction) => transaction.money.currency)).size > 1;
