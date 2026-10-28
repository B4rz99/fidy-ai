import { RefreshButton } from "@/ui/components/refresh-button";
import { useTransactionCorrections } from "./correction-context";

import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { type Array as Arr, BigDecimal, DateTime, Option } from "effect";
import { type CanonicalInput } from "@/transport/client";

import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { CalendarField } from "@/ui/components/calendar-field";
import type { CorrectionStatus } from "./panel-state";
import type { Category, Transaction } from "./presentation";

type BulkDraft = Readonly<{
  categoryId: string;
  direction: string;
  counterparty: string;
  notes: string;
  amount: string;
  date: string;
}>;
type Changes = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
type BulkProps = Readonly<{
  transactions: Arr.NonEmptyReadonlyArray<Transaction>;
  categories: ReadonlyArray<Category>;
  timeZone: string;
  onCancel: () => void;
  renderForm: (form: JSX.Element) => JSX.Element;
}>;
const draftFacts = (draft: BulkDraft, props: BulkProps): Changes => ({
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
const draftMoney = (draft: BulkDraft, props: BulkProps): Option.Option<Changes> => {
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
const draftChanges = (draft: BulkDraft, props: BulkProps): Option.Option<Changes> =>
  Option.all({ money: draftMoney(draft, props), date: draftDate(draft, props.timeZone) }).pipe(
    Option.map(({ money, date }) => ({ ...draftFacts(draft, props), ...money, ...date }))
  );
const BulkAmount = ({
  draft,
  onChange,
  props,
}: Readonly<{
  draft: BulkDraft;
  onChange: (draft: BulkDraft) => void;
  props: BulkProps;
}>): JSX.Element => {
  const mixedCurrencies =
    new Set(props.transactions.map((record) => record.money.currency)).size > 1;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-amount">
        Monto ·{" "}
        {new Set(props.transactions.map((record) => record.money.currency)).size === 1
          ? props.transactions[0].money.currency
          : "Varias monedas"}
      </Label>
      <Input
        id="bulk-amount"
        placeholder="Sin cambiar"
        inputMode="decimal"
        disabled={mixedCurrencies}
        aria-describedby={mixedCurrencies ? "bulk-amount-help" : undefined}
        value={draft.amount}
        onChange={(event) => onChange({ ...draft, amount: event.target.value })}
      />
      {mixedCurrencies ? (
        <p id="bulk-amount-help" className="text-sm text-muted-foreground">
          Para cambiar el monto en conjunto, selecciona transacciones con la misma moneda.
        </p>
      ) : null}
    </div>
  );
};
type BulkFieldProps = Readonly<{
  draft: BulkDraft;
  onChange: (draft: BulkDraft) => void;
  props: BulkProps;
  locked: boolean;
}>;
const BulkFields = ({ draft, onChange, props, locked }: BulkFieldProps): JSX.Element => (
  <fieldset disabled={locked} data-transaction-slot="transaction-bulk-fields">
    <legend className="sr-only">Cambios para las transacciones seleccionadas</legend>
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-counterparty">Contraparte</Label>
      <Input
        id="bulk-counterparty"
        placeholder="Sin cambiar"
        maxLength={120}
        value={draft.counterparty}
        onChange={(event) => onChange({ ...draft, counterparty: event.target.value })}
      />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-category">Categoría</Label>
      <ChoiceDropdown
        triggerLabel={Option.none()}
        width="full"
        leading={null}
        id="bulk-category"
        label="Categoría de la selección"
        value={draft.categoryId}
        disabled={locked}
        onChange={(categoryId) => onChange({ ...draft, categoryId })}
        options={[
          { value: "keep", label: "Sin cambiar" },
          ...props.categories.map((category) => ({ value: category.id, label: category.label })),
        ]}
      />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-direction">Tipo</Label>
      <ChoiceDropdown
        triggerLabel={Option.none()}
        width="full"
        leading={null}
        id="bulk-direction"
        label="Tipo de la selección"
        value={draft.direction}
        disabled={locked}
        onChange={(direction) => onChange({ ...draft, direction })}
        options={[
          { value: "keep", label: "Sin cambiar" },
          { value: "outflow", label: "Gasto" },
          { value: "inflow", label: "Ingreso" },
        ]}
      />
    </div>
    <BulkTextFields draft={draft} onChange={onChange} props={props} />
  </fieldset>
);
const BulkTextFields = ({
  draft,
  onChange,
  props,
}: Readonly<{
  draft: BulkDraft;
  onChange: (draft: BulkDraft) => void;
  props: BulkProps;
}>): JSX.Element => (
  <>
    <BulkAmount draft={draft} onChange={onChange} props={props} />
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-date">Fecha</Label>
      <CalendarField
        required={false}
        label="Fecha"
        timeZone={props.timeZone}
        disabled={false}
        appearance="field"
        id="bulk-date"
        value={draft.date}
        onChange={(date) => onChange({ ...draft, date })}
      />
      <Button variant="ghost" onClick={() => onChange({ ...draft, date: "" })}>
        Sin cambiar fecha
      </Button>
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-notes">Notas</Label>
      <textarea
        id="bulk-notes"
        placeholder="Sin cambiar"
        maxLength={500}
        value={draft.notes}
        onChange={(event) => onChange({ ...draft, notes: event.target.value })}
      />
    </div>
  </>
);
const BulkFeedback = ({
  status,
  recover,
}: Readonly<{ status: CorrectionStatus; recover: () => void }>): JSX.Element => (
  <>
    {status === "invalid" ? <p role="alert">Revisa los campos que quieres cambiar.</p> : null}
    {status === "rejected" || status === "uncertain" ? (
      <div role="alert">
        <p>
          {status === "rejected"
            ? "No se guardó ningún cambio. Actualiza el historial y revisa la selección."
            : "No pudimos confirmar los cambios. Actualiza el historial antes de volver a editar."}
        </p>
        <RefreshButton variant="outline" onClick={recover} label="Actualizar historial" />
      </div>
    ) : null}
  </>
);
const BulkHeading = ({ count }: Readonly<{ count: number }>): JSX.Element => (
  <header>
    <h2>Editar transacciones</h2>
    <p data-transaction-slot="transaction-panel-note">{count} transacciones seleccionadas</p>
  </header>
);
/** Sends one revision-checked atomic correction and never replays an uncertain save. */
export const BulkTransactionCorrection = (props: BulkProps): JSX.Element => {
  const [draft, setDraft] = useState<BulkDraft>({
    categoryId: "keep",
    direction: "keep",
    counterparty: "",
    notes: "",
    amount: "",
    date: "",
  });
  const corrections = useTransactionCorrections();
  const [invalid, setInvalid] = useState(false);
  const feedback = corrections.status === "recovering" ? "saving" : corrections.status;
  const status: CorrectionStatus = feedback === "idle" && invalid ? "invalid" : feedback;
  const locked = corrections.locked;
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked) return;
    const changes = draftChanges(draft, props);
    if (Option.isNone(changes) || Object.keys(changes.value).length === 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    corrections.submit({ kind: "bulk", transactions: props.transactions, changes: changes.value });
  };
  return props.renderForm(
    <form
      aria-label="Editar transacciones seleccionadas"
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
    >
      <BulkHeading count={props.transactions.length} />
      <BulkFields draft={draft} onChange={setDraft} props={props} locked={locked} />
      <p className="text-sm text-muted-foreground">
        Los campos vacíos o sin cambiar conservan su valor en cada transacción.
      </p>
      <BulkFeedback status={status} recover={corrections.recover} />
      <div data-transaction-slot="transaction-form-actions">
        <Button variant="outline" disabled={status === "saving"} onClick={props.onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={locked}>
          {status === "saving" ? "Guardando…" : "Guardar"}
        </Button>
      </div>
    </form>
  );
};
