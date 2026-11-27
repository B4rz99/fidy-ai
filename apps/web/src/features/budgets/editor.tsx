import { Alert, AlertDescription } from "@/ui/components/alert";
import { BudgetWriteFeedback } from "./write-feedback";
import { BudgetDeletion } from "./deletion";
import { AmountInput } from "@/ui/components/amount-input";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { BigDecimal, Option } from "effect";
import { type FormEvent, type JSX, type RefCallback, useCallback, useRef, useState } from "react";
import { Currency } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { type BudgetDraft, type BudgetEdit, type GroupRecovery, type SaveState } from "./model";
import { defaultBudgetGroup } from "./presentation";
import { currencyChoices } from "@/ui/currency-choices";

type EditorProps = Readonly<{
  draft: BudgetDraft;
  month: string;
  groups: ReadonlyArray<string>;
  groupCurrencies: ReadonlyArray<Readonly<{ group: string; currency: string }>>;
  disabled: boolean;
  onSubmit: (edit: BudgetEdit) => void;
  onClose: () => void;
  onRemove: () => void;
  onRefresh: () => void;
  groupRecovery: GroupRecovery;
  saveState: SaveState;
  writeAction: "save" | "delete";
}>;

const AmountField = ({
  amount,
  onAmount,
  invalid,
  field,
}: Readonly<{
  amount: string;
  onAmount: (value: string) => void;
  invalid: boolean;
  field: React.Ref<HTMLInputElement>;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="budget-cap">Presupuesto</Label>
    <AmountInput
      width="full"
      id="budget-cap"
      ref={field}
      validation="semantic"
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? "budget-cap-error" : undefined}
      required
      value={amount}
      onChange={(event) => onAmount(event.target.value)}
    />
    {invalid ? (
      <p id="budget-cap-error" role="alert" className="text-sm text-error-foreground">
        Ingresa un importe mayor que cero.
      </p>
    ) : null}
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
      options={currencyChoices(Currency.literals)}
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
  invalid,
  field,
  readOnly,
}: Readonly<{
  group: string;
  groups: ReadonlyArray<string>;
  disabled: boolean;
  onGroup: (value: string) => void;
  invalid: boolean;
  field: React.Ref<HTMLInputElement>;
  readOnly: boolean;
}>): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="budget-group">Grupo</Label>
      <Input
        id="budget-group"
        ref={field}
        validation="semantic"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? "budget-group-error" : undefined}
        required
        maxLength={64}
        readOnly={readOnly}
        value={group}
        onChange={(event) => onGroup(event.target.value)}
      />
      {invalid ? (
        <p id="budget-group-error" role="alert" className="text-sm text-error-foreground">
          Ingresa un nombre para el grupo.
        </p>
      ) : null}
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

type EditorForm = Readonly<{
  amount: string;
  invalid: "amount" | "group" | "none";
  amountField: React.Ref<HTMLInputElement>;
  groupField: React.Ref<HTMLInputElement>;
  setAmount: (value: string) => void;
  currency: string;
  setCurrency: (value: string) => void;
  group: string;
  onGroup: (value: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}>;

const useEditorCurrency = (
  draft: BudgetDraft,
  groupCurrencies: EditorProps["groupCurrencies"]
): Pick<EditorForm, "currency" | "setCurrency"> => {
  const savedCurrency = Option.map(draft.budget, (budget) => budget.cap.currency);

  const [currencyDraft, setCurrencyDraft] = useState(() => ({
    target: draft,
    value: Option.getOrElse(
      savedCurrency,
      () =>
        groupCurrencies.find((entry) => entry.group === defaultBudgetGroup(draft.category.label))
          ?.currency ?? "COP"
    ),
  }));

  const currency =
    Option.isSome(draft.groupCategoryIds) && currencyDraft.target !== draft
      ? Option.getOrElse(savedCurrency, () => currencyDraft.value)
      : currencyDraft.value;

  const setCurrency = (value: string): void => {
    setCurrencyDraft({ target: draft, value });
  };

  return { currency, setCurrency };
};

const invalidEditorField = ({
  amount,
  group,
  groupEditor,
}: Readonly<{
  amount: string;
  group: string;
  groupEditor: boolean;
}>): EditorForm["invalid"] => {
  const value = BigDecimal.fromString(amount.trim().replace(",", "."));

  if (!groupEditor && !Option.exists(value, BigDecimal.isPositive)) return "amount";

  return group.trim().length === 0 ? "group" : "none";
};

const budgetEdit = ({
  draft,
  amount,
  currency,
  group,
}: Pick<EditorForm, "amount" | "currency" | "group"> &
  Readonly<{ draft: BudgetDraft }>): BudgetEdit => {
  const groupEditor = Option.isSome(draft.groupCategoryIds);

  return {
    target: draft,
    amount: groupEditor
      ? Option.match(draft.budget, {
          onNone: () => amount,
          onSome: (budget) => BigDecimal.format(budget.cap.amount),
        })
      : amount,
    currency,
    groupName: group.trim(),
    groupCurrency: groupEditor ? Option.some(currency) : Option.none(),
  };
};

const useEditor = ({
  draft,
  groupCurrencies,
  disabled,
  onSubmit,
}: Pick<EditorProps, "draft" | "groupCurrencies" | "disabled" | "onSubmit">): EditorForm => {
  const amountField = useRef<HTMLInputElement>(null);
  const groupField = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState<EditorForm["invalid"]>("none");
  const groupEditor = Option.isSome(draft.groupCategoryIds);

  const [amount, setAmount] = useState(() =>
    Option.match(draft.budget, {
      onNone: () => "",
      onSome: (budget) => BigDecimal.format(budget.cap.amount),
    })
  );

  const [group, setGroup] = useState(() =>
    Option.match(draft.budget, {
      onNone: () => defaultBudgetGroup(draft.category.label),
      onSome: (budget) => budget.groupName ?? defaultBudgetGroup(draft.category.label),
    })
  );

  const { currency, setCurrency } = useEditorCurrency(draft, groupCurrencies);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (disabled) return;

    const issue = invalidEditorField({ amount, group, groupEditor });
    setInvalid(issue);

    if (issue === "none") onSubmit(budgetEdit({ draft, amount, currency, group }));
    else (issue === "amount" ? amountField : groupField).current?.focus();
  };

  const onGroup = (next: string): void => {
    setGroup(next);

    if (invalid === "group") setInvalid("none");

    const inherited = groupCurrencies.find((entry) => entry.group === next);

    if (inherited !== undefined) setCurrency(inherited.currency);
  };

  return {
    amount,
    invalid,
    amountField,
    groupField,
    currency,
    setCurrency,
    group,
    onGroup,
    submit,
    setAmount: (value) => {
      setAmount(value);

      if (invalid === "amount") setInvalid("none");
    },
  };
};

export const BudgetEditor = (props: EditorProps): JSX.Element => {
  const {
    draft,
    month,
    disabled,
    onSubmit,
    onRemove,
    onRefresh,
    groupRecovery,
    saveState,
    writeAction,
  } = props;

  const [deletionStep, setDeletionStep] = useState<"editing" | "reviewing" | "returning">(
    "editing"
  );

  const focusRemoval = useCallback<RefCallback<HTMLButtonElement>>(
    (button): void => {
      if (deletionStep === "returning") button?.focus();
    },
    [deletionStep]
  );

  const editor = useEditor({
    draft,
    groupCurrencies: props.groupCurrencies,
    disabled: disabled || blocksEditor(groupRecovery),
    onSubmit,
  });

  if (deletionStep === "reviewing") {
    return (
      <BudgetDeletion
        draft={draft}
        month={month}
        disabled={disabled}
        onCancel={() => setDeletionStep("returning")}
        onRemove={onRemove}
        onRefresh={onRefresh}
        saveState={writeAction === "delete" ? saveState : "idle"}
      />
    );
  }

  return (
    <EditorForm
      {...props}
      editor={editor}
      onDelete={() => setDeletionStep("reviewing")}
      onRemovalMount={focusRemoval}
    />
  );
};

const BudgetEditorFeedback = ({
  saveState,
  writeAction,
  onRefresh,
}: Pick<EditorProps, "saveState" | "writeAction" | "onRefresh">): JSX.Element => (
  <>
    {writeAction === "save" ? (
      <BudgetWriteFeedback inline={false} saveState={saveState} writeAction={writeAction} />
    ) : null}
    {saveState === "uncertain" ? (
      <Button type="button" variant="outline" onClick={onRefresh}>
        Actualizar presupuestos
      </Button>
    ) : null}
  </>
);

const groupRecoveryCopy = {
  required: "No pudimos guardar los cambios. Actualiza para comprobar la moneda guardada.",
  conflict: "El presupuesto cambió desde que abriste este editor.",
  refreshing: "Actualizando presupuestos…",
  retry: "No pudimos actualizar los presupuestos. Vuelve a intentarlo.",
  unavailable:
    "El grupo cambió o ya no está disponible. Tu nombre sigue en el campo Grupo para que puedas copiarlo antes de cerrar.",
} as const;

const focusGroupReview: RefCallback<HTMLOutputElement> = (node) => {
  const currency = node
    ?.closest("form")
    ?.querySelector<HTMLButtonElement>("#budget-group-currency");

  if (Option.exists(Option.fromNullishOr(currency), (trigger) => !trigger.disabled)) {
    currency?.focus();
  } else node?.focus();
};

const GroupRecoveryFeedback = ({
  state,
  saveState,
  currency,
  onRefresh,
}: Readonly<{
  state: Exclude<GroupRecovery, "idle">;
  saveState: SaveState;
  currency: Option.Option<string>;
  onRefresh: () => void;
}>): JSX.Element =>
  state === "review" ? (
    <Alert role="presentation" variant="information">
      <output ref={focusGroupReview} tabIndex={-1}>
        Moneda guardada: {Option.getOrElse(currency, () => "")}. Revisa el grupo antes de guardar.
      </output>
    </Alert>
  ) : (
    <Alert role="alert" variant="warning">
      <AlertDescription>
        <strong>
          {state === "required" && saveState === "uncertain"
            ? "No pudimos confirmar el guardado. Actualiza para comprobar el plan."
            : groupRecoveryCopy[state]}
        </strong>
      </AlertDescription>
      {state === "conflict" ? (
        <AlertDescription>
          Actualiza para ver la moneda guardada antes de volver a guardar. Conservaremos el nombre
          que escribiste.
        </AlertDescription>
      ) : null}
      {state === "unavailable" ? null : (
        <Button
          type="button"
          variant="outline"
          contentLayout="wrap"
          className="mt-2 justify-self-start"
          disabled={state === "refreshing"}
          onClick={onRefresh}
        >
          Actualizar presupuestos
        </Button>
      )}
    </Alert>
  );

type EditorFormProps = EditorProps &
  Readonly<{
    editor: EditorForm;
    onDelete: () => void;
    onRemovalMount: RefCallback<HTMLButtonElement>;
  }>;

const blocksEditor = (state: GroupRecovery): boolean => state !== "idle" && state !== "review";

const groupCurrencyAvailable = (
  props: Pick<EditorProps, "draft" | "groupCurrencies">,
  group: string
): boolean =>
  Option.isSome(props.draft.groupCategoryIds) ||
  !props.groupCurrencies.some((entry) => entry.group === group);

const GroupCurrencyGuidance = (): JSX.Element => (
  <p className="text-sm text-muted-foreground">
    La moneda se aplica a todas las categorías del grupo desde este mes. Los importes conservan su
    valor; no se convierten.
  </p>
);

const EditorFields = ({
  draft,
  groups,
  groupCurrencies,
  disabled,
  groupRecovery,
  saveState,
  editor,
}: EditorFormProps): JSX.Element => {
  const {
    amount,
    setAmount,
    currency,
    setCurrency,
    group,
    onGroup,
    invalid,
    amountField,
    groupField,
  } = editor;

  const groupEditor = Option.isSome(draft.groupCategoryIds);
  const unavailable = groupRecovery === "unavailable";
  const updatingGroup = blocksEditor(groupRecovery) && !unavailable;
  const locked = disabled || unavailable;
  const showCurrency = groupCurrencyAvailable({ draft, groupCurrencies }, group);

  return (
    <fieldset disabled={disabled || updatingGroup} className="flex flex-col gap-4">
      {!groupEditor ? (
        <AmountField
          amount={amount}
          onAmount={setAmount}
          invalid={invalid === "amount"}
          field={amountField}
        />
      ) : null}
      <GroupField
        group={group}
        groups={groups}
        disabled={locked}
        onGroup={onGroup}
        invalid={invalid === "group"}
        field={groupField}
        readOnly={unavailable}
      />
      {showCurrency ? (
        <GroupCurrencyField currency={currency} disabled={locked} onCurrency={setCurrency} />
      ) : (
        <p className="text-sm text-muted-foreground">Moneda del grupo: {currency}</p>
      )}
      {groupEditor ? <GroupCurrencyGuidance /> : null}
      <Button type="submit" disabled={unavailable}>
        {saveState === "saving" ? "Guardando…" : "Guardar presupuesto"}
      </Button>
    </fieldset>
  );
};

const EditorForm = (props: EditorFormProps): JSX.Element => {
  const {
    draft,
    disabled,
    editor,
    groupRecovery,
    saveState,
    writeAction,
    onRefresh,
    onDelete,
    onRemovalMount,
  } = props;

  const removable = Option.isSome(draft.budget) && Option.isNone(draft.groupCategoryIds);

  return (
    <form
      noValidate
      onSubmit={editor.submit}
      className="flex flex-col gap-5"
      aria-label={`Configurar presupuesto de ${draft.category.label}`}
    >
      <EditorHeading {...props} />
      {groupRecovery === "idle" ? null : (
        <GroupRecoveryFeedback
          state={groupRecovery}
          saveState={saveState}
          currency={Option.map(draft.budget, (budget) => budget.cap.currency)}
          onRefresh={onRefresh}
        />
      )}
      <EditorFields {...props} />

      {groupRecovery === "idle" && editor.invalid === "none" ? (
        <BudgetEditorFeedback {...{ saveState, writeAction, onRefresh }} />
      ) : null}
      {removable ? (
        <Button
          ref={onRemovalMount}
          type="button"
          variant="destructive"
          contentLayout="wrap"
          disabled={disabled}
          onClick={onDelete}
        >
          Eliminar presupuesto
        </Button>
      ) : null}
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
      <Button type="button" variant="ghost" onClick={onClose} disabled={disabled}>
        Cerrar
      </Button>
    </div>
    <p className="text-sm text-muted-foreground">
      Plan de {month}. El importe afecta este mes guardado; los grupos organizan todos los meses.
    </p>
  </>
);
