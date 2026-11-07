import { RefreshButton } from "@/ui/components/refresh-button";

import type { JSX } from "react";

import { Option } from "effect";
import { InlineChoiceDropdown } from "@/ui/components/choice-dropdown";
import { useTransactionCorrections } from "./correction-context";
import { CategoryVisual } from "@/ui/components/category-visual";
import type { Category, Transaction, TransactionListRow } from "./presentation";

type CategoryProps = Readonly<{
  row: TransactionListRow;
  transaction: Transaction;
  categories: ReadonlyArray<Category>;
  disabled: boolean;
}>;
type SaveStatus = "idle" | "saving" | "rejected" | "uncertain" | "refreshing" | "recovered";
const feedbackCopy: Readonly<Record<SaveStatus, string>> = {
  idle: "",
  saving: "Guardando categoría…",
  refreshing: "No se guardó la categoría. Actualizando el historial automáticamente.",
  recovered: "No se guardó la categoría. Ya actualizamos el historial. Puedes volver a elegirla.",
  rejected: "No se guardó la categoría. No pudimos actualizar el historial.",
  uncertain: "No pudimos confirmar el cambio. Actualiza el historial antes de volver a editar.",
};
const CategoryFeedback = ({
  status,
  onRefresh,
}: Readonly<{ status: SaveStatus; onRefresh: () => void }>): JSX.Element => {
  if (status === "rejected" || status === "uncertain") {
    return (
      <div className="text-xs">
        <p role="alert">{feedbackCopy[status]}</p>
        <RefreshButton
          variant="ghost"
          onClick={onRefresh}
          label={status === "rejected" ? "Reintentar" : "Actualizar historial"}
        />
      </div>
    );
  }
  return status === "idle" ? (
    <></>
  ) : (
    <output className="text-xs text-muted-foreground">{feedbackCopy[status]}</output>
  );
};
const CategoryCorrection = (props: CategoryProps): JSX.Element => {
  const corrections = useTransactionCorrections();
  const feedback = corrections.status === "recovering" ? "saving" : corrections.status;
  const status: SaveStatus = Option.contains(corrections.inlineTransaction, props.transaction.id)
    ? feedback
    : "idle";
  const change = (categoryId: string): void => {
    if (props.disabled || corrections.locked || categoryId === props.transaction.categoryId) return;
    const category = Option.fromNullishOr(props.categories.find((item) => item.id === categoryId));
    if (Option.isNone(category)) return;
    corrections.submit({
      kind: "single",
      origin: "inline",
      transaction: props.transaction,
      changes: { categoryId: category.value.id },
    });
  };
  return (
    <div className="min-w-0">
      <InlineChoiceDropdown
        label={`Cambiar categoría de ${props.row.counterpartyLabel}`}
        disabled={props.disabled || corrections.locked}
        leading={<CategoryVisual label={props.row.categoryLabel} bubble large={false} />}
        value={props.transaction.categoryId}
        options={props.categories.map((category) => ({
          value: category.id,
          label: category.label,
        }))}
        onChange={change}
      >
        {props.row.categoryLabel}
      </InlineChoiceDropdown>
      <CategoryFeedback status={status} onRefresh={corrections.recover} />
    </div>
  );
};
export const InlineTransactionCategory = ({
  transactions,
  ...props
}: Omit<CategoryProps, "transaction"> &
  Readonly<{ transactions: ReadonlyArray<Transaction> }>): JSX.Element => {
  const transaction = Option.fromNullishOr(transactions.find((item) => item.id === props.row.id));
  return Option.isSome(transaction) ? (
    <CategoryCorrection
      key={`${transaction.value.id}:${transaction.value.revision}`}
      {...props}
      transaction={transaction.value}
    />
  ) : (
    <span>{props.row.categoryLabel}</span>
  );
};
