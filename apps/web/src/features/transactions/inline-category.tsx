import { useState } from "react";
import type { JSX } from "react";
import { useAtomSet } from "@effect/atom-react";
import { Option } from "effect";
import type { FidyClient } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { InlineChoiceDropdown } from "@/ui/components/choice-dropdown";
import { makeTransactionCorrection } from "./correction-command";
import { CategoryVisual } from "./visuals";
import type { Category, Transaction, TransactionListRow } from "./presentation";

type CategoryProps = Readonly<{
  row: TransactionListRow;
  transaction: Transaction;
  categories: ReadonlyArray<Category>;
  apiClient: FidyClient;
  disabled: boolean;
  onRefresh: () => void;
  onSaved: () => void;
}>;
type SaveStatus = "idle" | "saving" | "rejected" | "uncertain";
const CategoryFeedback = ({
  status,
  onRefresh,
}: Readonly<{ status: SaveStatus; onRefresh: () => void }>): JSX.Element => (
  <>
    {status === "saving" ? (
      <output className="text-xs text-muted-foreground">Guardando categoría…</output>
    ) : null}
    {status === "rejected" || status === "uncertain" ? (
      <div className="text-xs">
        <p role="alert">
          {status === "rejected"
            ? "No se guardó la categoría. Actualiza el historial."
            : "No pudimos confirmar el cambio. Actualiza el historial antes de volver a editar."}
        </p>
        <Button variant="ghost" onClick={onRefresh}>
          Actualizar historial
        </Button>
      </div>
    ) : null}
  </>
);
const CategoryCorrection = (props: CategoryProps): JSX.Element => {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [command] = useState(() =>
    makeTransactionCorrection({ apiClient: props.apiClient, transaction: props.transaction })
  );
  const submit = useAtomSet(command);
  const change = (categoryId: string): void => {
    if (props.disabled || status !== "idle" || categoryId === props.transaction.categoryId) return;
    const category = Option.fromNullishOr(props.categories.find((item) => item.id === categoryId));
    if (Option.isNone(category)) return;
    setStatus("saving");
    submit({
      changes: { categoryId: category.value.id },
      onSaved: props.onSaved,
      onRejected: () => setStatus("rejected"),
      onUncertain: () => setStatus("uncertain"),
    });
  };
  return (
    <div className="min-w-0">
      <InlineChoiceDropdown
        label={`Cambiar categoría de ${props.row.counterpartyLabel}`}
        disabled={props.disabled || status !== "idle"}
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
      <CategoryFeedback
        status={status}
        onRefresh={() => {
          props.onRefresh();
          setStatus("idle");
        }}
      />
    </div>
  );
};
/** Saves a single observed Transaction category without changing the active panel. */
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
