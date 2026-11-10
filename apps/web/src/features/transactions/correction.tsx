import { MoneyField } from "./money-field";
import { formatMoneyInput, parseMoneyInput } from "@/transport/money-input";
import { CorrectionRecoveryFeedback } from "./correction-feedback";

import { BigDecimal, DateTime, Option, Schema } from "effect";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import type { CanonicalInput } from "@/transport/client";
import { Currency } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { useTransactionCorrections } from "./correction-context";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import type { Category, Transaction } from "./presentation";

import { CalendarField } from "@/ui/components/calendar-field";
import type { CorrectionStatus } from "./panel-state";

type CorrectionDraft = Readonly<{
  amount: string;
  currency: Transaction["money"]["currency"];
  counterparty: string;
  notes: string;
  date: string;
  direction: Transaction["direction"];
  categoryId: string;
}>;
type CorrectionProps = Readonly<{
  renderForm: (form: JSX.Element) => JSX.Element;
  transaction: Transaction;
  categories: ReadonlyArray<Category>;
  timeZone: string;
  onCancel: () => void;
}>;
const localDate = (transaction: Transaction, timeZone: string): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
  );
const initialDraft = (transaction: Transaction, timeZone: string): CorrectionDraft => ({
  amount: formatMoneyInput(transaction.money),
  currency: transaction.money.currency,
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
const parseDate = (draft: CorrectionDraft, timeZone: string): Option.Option<DateTime.Zoned> =>
  DateTime.makeZoned(`${draft.date}T00:00:00.000Z`, { timeZone, adjustForTimeZone: true }).pipe(
    Option.filter((date) => DateTime.formatIsoDate(date) === draft.date)
  );
const moneyChanged = (money: Transaction["money"], original: Transaction["money"]): boolean =>
  money.currency !== original.currency || BigDecimal.Order(money.amount, original.amount) !== 0;
const correctionChanges = (
  draft: CorrectionDraft,
  props: CorrectionProps
): Option.Option<CorrectionChanges> => {
  const money = parseMoneyInput({ text: draft.amount, currency: draft.currency });
  const occurredAt = parseDate(draft, props.timeZone);
  const category = Option.fromNullishOr(
    props.categories.find((item) => item.id === draft.categoryId)
  );
  if (Option.isNone(money) || Option.isNone(occurredAt) || Option.isNone(category)) {
    return Option.none();
  }
  const original = initialDraft(props.transaction, props.timeZone);
  const changes: CorrectionChanges = {
    ...textChanges(draft, original),
    ...(moneyChanged(money.value, props.transaction.money) ? { money: money.value } : {}),
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
const DraftInputs = ({
  draft,
  timeZone,
  locked,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  timeZone: string;
  locked: boolean;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <>
    <div data-transaction-slot="transaction-correction-money">
      <MoneyField
        revealErrors={false}
        id="correction-amount"
        currency={draft.currency}
        label="Monto"
        required
        disabled={false}
        value={draft.amount}
        onChange={(amount) => onChange({ ...draft, amount })}
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="correction-currency">Moneda</Label>
        <SearchableChoiceDropdown
          id="correction-currency"
          label="Moneda"
          value={draft.currency}
          options={Currency.literals.map((value) => ({ value, label: value }))}
          disabled={locked}
          width="full"
          onChange={(value) => {
            const selected = Schema.decodeUnknownOption(Currency)(value);
            if (Option.isSome(selected)) onChange({ ...draft, currency: selected.value });
          }}
        />
      </div>
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-date">Fecha</Label>
      <CalendarField
        required
        label="Fecha"
        timeZone={timeZone}
        disabled={false}
        appearance="field"
        id="correction-date"
        value={draft.date}
        onChange={(date) => onChange({ ...draft, date })}
      />
    </div>
  </>
);
const DraftCategory = ({
  draft,
  categories,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  categories: ReadonlyArray<Category>;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="correction-category">Categoría</Label>
    <ChoiceDropdown
      triggerLabel={Option.none()}
      id="correction-category"
      label="Categoría"
      width="full"
      disabled={false}
      leading={null}
      value={draft.categoryId}
      options={categories.map((category) => ({ value: category.id, label: category.label }))}
      onChange={(categoryId) => onChange({ ...draft, categoryId })}
    />
  </div>
);
const DraftDescription = ({
  draft,
  categories,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  categories: ReadonlyArray<Category>;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-counterparty">Contraparte</Label>
      <Input
        id="correction-counterparty"
        maxLength={120}
        value={draft.counterparty}
        onChange={(event) => onChange({ ...draft, counterparty: event.target.value })}
      />
    </div>
    <DraftCategory draft={draft} categories={categories} onChange={onChange} />
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-direction">Tipo</Label>
      <ChoiceDropdown
        triggerLabel={Option.none()}
        id="correction-direction"
        label="Tipo"
        width="full"
        disabled={false}
        leading={null}
        value={draft.direction}
        options={[
          { value: "outflow", label: "Gasto" },
          { value: "inflow", label: "Ingreso" },
        ]}
        onChange={(value) =>
          onChange({ ...draft, direction: value === "inflow" ? "inflow" : "outflow" })
        }
      />
    </div>
  </>
);
const DraftNotes = ({
  draft,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="correction-notes">Notas (opcional)</Label>
    <textarea
      id="correction-notes"
      placeholder="Añadir una nota"
      maxLength={500}
      value={draft.notes}
      onChange={(event) => onChange({ ...draft, notes: event.target.value })}
    />
  </div>
);
const CorrectionFeedback = ({ status }: Readonly<{ status: CorrectionStatus }>): JSX.Element => (
  <>
    {status === "invalid" ? (
      <p role="alert" className="text-sm text-destructive">
        Revisa el monto, la fecha y la categoría.
      </p>
    ) : null}
  </>
);
const saveLabel = (status: CorrectionStatus): string => {
  if (status === "refreshing") return "Actualizando…";
  return status === "saving" ? "Guardando…" : "Guardar";
};
const CorrectionActions = ({
  status,
  locked,
  onCancel,
}: Readonly<{
  status: CorrectionStatus;
  locked: boolean;
  onCancel: () => void;
}>): JSX.Element => (
  <div data-transaction-slot="transaction-form-actions">
    <Button type="button" variant="outline" disabled={status === "saving"} onClick={onCancel}>
      Cancelar
    </Button>
    <Button type="submit" disabled={locked}>
      {saveLabel(status)}
    </Button>
  </div>
);
/** Corrects only explicitly changed facts at the observed revision; an uncertain write is never replayed. */
export const TransactionCorrection = (input: CorrectionProps): JSX.Element => {
  const [props] = useState(() => input);
  const [draft, setDraft] = useState(() => initialDraft(props.transaction, props.timeZone));
  const corrections = useTransactionCorrections();
  const [submit] = useState(() => corrections.submit);
  const [submission, setSubmission] = useState<"pristine" | "invalid" | "submitted">("pristine");
  const feedback = corrections.status === "recovering" ? "saving" : corrections.status;
  const status: CorrectionStatus =
    !corrections.locked && submission === "invalid" ? "invalid" : feedback;
  const locked = corrections.locked;
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked) return;
    const changes = correctionChanges(draft, props);
    if (Option.isNone(changes)) {
      setSubmission("invalid");
      return;
    }
    if (Object.keys(changes.value).length === 0) {
      props.onCancel();
      return;
    }
    setSubmission("submitted");
    submit({
      kind: "single",
      origin: "editor",
      transaction: props.transaction,
      changes: changes.value,
    });
  };
  return props.renderForm(
    <form aria-label="Corregir transacción" onSubmit={onSubmit} className="flex flex-col gap-5">
      <fieldset disabled={locked} data-transaction-slot="transaction-correction-fields">
        <legend className="sr-only">Datos de la transacción</legend>
        <DraftDescription draft={draft} categories={props.categories} onChange={setDraft} />
        <DraftInputs draft={draft} timeZone={props.timeZone} locked={locked} onChange={setDraft} />
        <DraftNotes draft={draft} onChange={setDraft} />
      </fieldset>
      <CorrectionFeedback status={status} />
      {submission === "submitted" || corrections.status !== "recovered" ? (
        <CorrectionRecoveryFeedback kind="single" />
      ) : null}
      <CorrectionActions
        status={status}
        locked={
          locked || Option.isNone(parseMoneyInput({ text: draft.amount, currency: draft.currency }))
        }
        onCancel={props.onCancel}
      />
    </form>
  );
};
