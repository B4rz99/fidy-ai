import { useAtomSet } from "@effect/atom-react";
import { Currency } from "@/transport/client";
import { BigDecimal, Option, Schema } from "effect";
import { useState } from "react";
import type { CanonicalInput } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { makeBudgetWrite } from "./command";
import type { BudgetDraft, BudgetEdit, SaveState, WorkspaceProps } from "./model";

type ValidWrite =
  | Readonly<{ type: "create"; input: CanonicalInput<"budgets.createBudget"> }>
  | Readonly<{ type: "update"; input: CanonicalInput<"budgets.updateBudget"> }>;
const validatedWrite = ({
  edit,
  month,
}: Readonly<{ edit: BudgetEdit; month: string }>): Option.Option<ValidWrite> => {
  const amount = BigDecimal.fromString(edit.amount.trim().replace(",", "."));
  const currency = Schema.decodeUnknownOption(Currency)(edit.currency);
  if (Option.isNone(amount) || Option.isNone(currency)) {
    return Option.none();
  }
  const payload = {
    categoryId: edit.target.category.id,
    cap: {
      amount: amount.value,
      currency:
        Option.isSome(edit.groupCurrency) && Option.isSome(edit.target.budget)
          ? edit.target.budget.value.cap.currency
          : currency.value,
    },
    month,
    groupName: edit.groupName,
    ...Option.match(edit.groupCurrency, {
      onNone: () => ({}),
      onSome: () => ({ groupCurrency: currency.value }),
    }),
    ...Option.match(edit.target.groupCategoryIds, {
      onNone: () => ({}),
      onSome: (groupCategoryIds) => ({ groupCategoryIds }),
    }),
  };
  if (Option.isSome(edit.target.budget)) {
    const input: CanonicalInput<"budgets.updateBudget"> = {
      params: { id: edit.target.budget.value.id },
      payload,
    };
    return isCanonicalInput("budgets.updateBudget", input)
      ? Option.some({ type: "update", input })
      : Option.none();
  }
  const input: CanonicalInput<"budgets.createBudget"> = { payload };
  return isCanonicalInput("budgets.createBudget", input)
    ? Option.some({ type: "create", input })
    : Option.none();
};
export type BudgetController = Readonly<{
  saveState: SaveState;
  refreshVersion: number;
  disabled: boolean;
  draft: Option.Option<BudgetDraft>;
  setDraft: (value: Option.Option<BudgetDraft>) => void;
  write: (edit: BudgetEdit) => void;
  refresh: () => void;
}>;
/** Own interaction state; financial facts stay in the canonical query resource. */
export const useBudgetController = (props: WorkspaceProps): BudgetController => {
  const [save] = useState(() => makeBudgetWrite(props.apiClient));
  const submit = useAtomSet(save);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [draft, setDraft] = useState(Option.none<BudgetDraft>());
  const disabled = !props.editable || saveState === "saving" || saveState === "uncertain";
  const callbacks = {
    onSaved: (): void => {
      setSaveState("saved");
      setDraft(Option.none());
      props.onRefresh();
    },
    onRejected: (): void => setSaveState("failed"),
    onUncertain: (): void => setSaveState("uncertain"),
  };
  const write = (edit: BudgetEdit): void => {
    if (disabled) {
      return;
    }
    const parsed = validatedWrite({ edit, month: props.month });
    if (Option.isNone(parsed)) {
      setSaveState("failed");
      return;
    }
    setSaveState("saving");
    submit({ ...parsed.value, ...callbacks });
  };
  const refresh = (): void => {
    setRefreshVersion((version) => version + 1);
    setSaveState("idle");
    setDraft(Option.none());
    props.onRefresh();
  };
  return { saveState, refreshVersion, disabled, draft, setDraft, write, refresh };
};
