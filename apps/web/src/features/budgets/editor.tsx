import { AmountInput } from "@/ui/components/amount-input";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { BigDecimal, Option } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { Currency } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { type BudgetDraft, type BudgetEdit } from "./model";
import { defaultBudgetGroup } from "./presentation";

type EditorProps = Readonly<{
  draft: BudgetDraft;
  month: string;
  groups: ReadonlyArray<string>;
  groupCurrencies: ReadonlyArray<Readonly<{ group: string; currency: string }>>;
  disabled: boolean;
  onSubmit: (edit: BudgetEdit) => void;
  onClose: () => void;
}>;
const AmountField = ({
  amount,
  onAmount,
}: Readonly<{ amount: string; onAmount: (value: string) => void }>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="budget-cap">Presupuesto</Label>
    <AmountInput
      width="full"
      id="budget-cap"
      required
      value={amount}
      onChange={(event) => onAmount(event.target.value)}
    />
  </div>
);
const GroupCurrencyField = ({
  currency,
  disabled,
  onCurrency,
}: Readonly<{
  currency: string;
  disabled: boolean;
  onCurrency: (value: string) => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="budget-group-currency">Moneda del grupo</Label>
    <SearchableChoiceDropdown
      id="budget-group-currency"
      label="Moneda del grupo"
      value={currency}
      options={Currency.literals.map((value) => ({ value, label: value }))}
      disabled={disabled}
      width="full"
      onChange={onCurrency}
    />
  </div>
);
const GroupField = ({
  group,
  groups,
  disabled,
  onGroup,
}: Readonly<{
  group: string;
  groups: ReadonlyArray<string>;
  disabled: boolean;
  onGroup: (value: string) => void;
}>): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="budget-group">Grupo</Label>
      <Input
        id="budget-group"
        required
        maxLength={64}
        value={group}
        onChange={(event) => onGroup(event.target.value)}
      />
    </div>
    {groups.length > 0 ? (
      <ChoiceDropdown
        id="existing-budget-group"
        label="Elegir un grupo existente"
        value={group}
        options={groups.map((value) => ({ value, label: value }))}
        disabled={disabled}
        width="full"
        leading={null}
        triggerLabel={Option.some("Elegir un grupo existente")}
        onChange={onGroup}
      />
    ) : null}
    <p className="text-sm text-muted-foreground">
      Escribe un nombre nuevo o elige un grupo existente. Cada categoría conserva su propio
      presupuesto.
    </p>
  </>
);
const useEditor = ({
  draft,
  groupCurrencies,
  disabled,
  onSubmit,
}: Pick<EditorProps, "draft" | "groupCurrencies" | "disabled" | "onSubmit">): Readonly<{
  amount: string;
  setAmount: (value: string) => void;
  currency: string;
  setCurrency: (value: string) => void;
  group: string;
  onGroup: (value: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}> => {
  const [amount, setAmount] = useState(() =>
    Option.match(draft.budget, {
      onNone: () => "",
      onSome: (budget) => BigDecimal.format(budget.cap.amount),
    })
  );
  const [currency, setCurrency] = useState(() =>
    Option.match(draft.budget, {
      onNone: () =>
        groupCurrencies.find((entry) => entry.group === defaultBudgetGroup(draft.category.label))
          ?.currency ?? "COP",
      onSome: (budget) => budget.cap.currency,
    })
  );
  const [group, setGroup] = useState(() =>
    Option.match(draft.budget, {
      onNone: () => defaultBudgetGroup(draft.category.label),
      onSome: (budget) => budget.groupName ?? defaultBudgetGroup(draft.category.label),
    })
  );
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!disabled) {
      onSubmit({
        target: draft,
        amount,
        currency,
        groupName: group.trim(),
        groupCurrency: Option.isSome(draft.groupCategoryIds)
          ? Option.some(currency)
          : Option.none(),
      });
    }
  };
  const onGroup = (next: string): void => {
    setGroup(next);
    const inherited = groupCurrencies.find((entry) => entry.group === next);
    if (inherited !== undefined) setCurrency(inherited.currency);
  };
  return { amount, setAmount, currency, setCurrency, group, onGroup, submit };
};

export const BudgetEditor = ({
  draft,
  month,
  groups,
  groupCurrencies,
  disabled,
  onSubmit,
  onClose,
}: EditorProps): JSX.Element => {
  const { amount, setAmount, currency, setCurrency, group, onGroup, submit } = useEditor({
    draft,
    groupCurrencies,
    disabled,
    onSubmit,
  });
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5"
      aria-label={`Configurar presupuesto de ${draft.category.label}`}
    >
      <EditorHeading draft={draft} month={month} disabled={disabled} onClose={onClose} />
      <fieldset disabled={disabled} className="flex flex-col gap-4">
        {Option.isNone(draft.groupCategoryIds) ? (
          <AmountField amount={amount} onAmount={setAmount} />
        ) : null}
        <GroupField group={group} groups={groups} disabled={disabled} onGroup={onGroup} />
        {Option.isSome(draft.groupCategoryIds) ||
        !groupCurrencies.some((entry) => entry.group === group) ? (
          <GroupCurrencyField currency={currency} disabled={disabled} onCurrency={setCurrency} />
        ) : (
          <p className="text-sm text-muted-foreground">Moneda del grupo: {currency}</p>
        )}
        {Option.isSome(draft.groupCategoryIds) ? (
          <p className="text-sm text-muted-foreground">
            La moneda se aplica a todas las categorías del grupo desde este mes. Los importes
            conservan su valor; no se convierten.
          </p>
        ) : null}
        <Button type="submit">{disabled ? "Guardando…" : "Guardar presupuesto"}</Button>
      </fieldset>
    </form>
  );
};

const EditorHeading = ({
  draft,
  month,
  disabled,
  onClose,
}: Pick<EditorProps, "draft" | "month" | "disabled" | "onClose">): JSX.Element => (
  <>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">
        {Option.isNone(draft.groupCategoryIds) ? draft.category.label : "Configurar grupo"}
      </h2>
      <Button variant="ghost" onClick={onClose} disabled={disabled}>
        Cerrar
      </Button>
    </div>
    <p className="text-sm text-muted-foreground">
      Plan de {month}. El importe afecta este mes guardado; los grupos organizan todos los meses.
    </p>
  </>
);
