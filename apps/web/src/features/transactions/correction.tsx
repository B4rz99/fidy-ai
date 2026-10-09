import { useAtomSet } from "@effect/atom-react";
import { BigDecimal, Cause, DateTime, Effect, Option, Predicate } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import type { CanonicalInput, FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@/ui/components/native-select";
import type { Category, Transaction } from "./presentation";

import { TransactionDateField } from "./date-field";
import { CategoryVisual, DirectionVisual } from "./visuals";
import type { CorrectionStatus } from "./panel-state";

type CorrectionDraft = Readonly<{
  amount: string;
  counterparty: string;
  notes: string;
  date: string;
  direction: Transaction["direction"];
  categoryId: string;
}>;
type CorrectionProps = Readonly<{
  renderForm: (form: JSX.Element) => JSX.Element;
  apiClient: FidyClient;
  transaction: Transaction;
  categories: ReadonlyArray<Category>;
  timeZone: string;
  onSaved: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  status: CorrectionStatus;
  onStatus: (status: CorrectionStatus) => void;
}>;
const localDate = (transaction: Transaction, timeZone: string): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
  );
const initialDraft = (transaction: Transaction, timeZone: string): CorrectionDraft => ({
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
const correctionChanges = (
  draft: CorrectionDraft,
  props: CorrectionProps
): Option.Option<CorrectionChanges> => {
  const amount = parseAmount(draft.amount);
  const occurredAt = parseDate(draft, props.timeZone);
  const category = Option.fromNullishOr(
    props.categories.find((item) => item.id === draft.categoryId)
  );
  if (Option.isNone(amount) || Option.isNone(occurredAt) || Option.isNone(category)) {
    return Option.none();
  }
  const original = initialDraft(props.transaction, props.timeZone);
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
type CorrectionCommand = Readonly<{
  changes: CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
  onSaved: () => void;
  onRejected: () => void;
  onUncertain: () => void;
}>;
const makeCorrection = (
  apiClient: FidyClient,
  transaction: Transaction
): Atom.AtomResultFn<CorrectionCommand, void, never> =>
  apiClient.runtime.fn<CorrectionCommand>()((command) =>
    Effect.gen(function* () {
      const client = yield* apiClient;
      yield* client.transactions.updateTransaction({
        params: { id: transaction.id },
        payload: { expectedRevision: transaction.revision, changes: command.changes },
      });
      yield* Effect.sync(command.onSaved);
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(
          Predicate.isTagged(failure, "ValidationFailed") ||
            Predicate.isTagged(failure, "NotFound") ||
            Predicate.isTagged(failure, "ResourceLimited")
            ? command.onRejected
            : command.onUncertain
        )
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(command.onUncertain)
      )
    )
  );
const DraftInputs = ({
  draft,
  currency,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  currency: string;
  categories: ReadonlyArray<Category>;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-amount">Monto</Label>
      <div className="money-field">
        <span aria-hidden="true">{currency}</span>
        <Input
          id="correction-amount"
          aria-label={`Monto en ${currency}`}
          required
          inputMode="decimal"
          value={draft.amount}
          onChange={(event) => onChange({ ...draft, amount: event.target.value })}
        />
      </div>
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-date">Fecha</Label>
      <TransactionDateField
        required
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
    <div className="correction-select">
      <span aria-hidden="true">
        <CategoryVisual
          label={categories.find((category) => category.id === draft.categoryId)?.label ?? ""}
          bubble
          large={false}
        />
      </span>
      <NativeSelect
        id="correction-category"
        size="default"
        className="w-full"
        value={draft.categoryId}
        onChange={(event) => onChange({ ...draft, categoryId: event.target.value })}
      >
        {categories.map((category) => (
          <NativeSelectOption key={category.id} value={category.id}>
            {category.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  </div>
);
const DraftDescription = ({
  draft,
  categories,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  currency: string;
  categories: ReadonlyArray<Category>;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-counterparty">Contraparte</Label>
      <Input
        id="correction-counterparty"
        maxLength={200}
        value={draft.counterparty}
        onChange={(event) => onChange({ ...draft, counterparty: event.target.value })}
      />
    </div>
    <DraftCategory draft={draft} categories={categories} onChange={onChange} />
    <div className="flex flex-col gap-2">
      <Label htmlFor="correction-direction">Tipo</Label>
      <div className="correction-select">
        <span aria-hidden="true">
          <DirectionVisual inflow={draft.direction === "inflow"} />
        </span>
        <NativeSelect
          className="w-full"
          id="correction-direction"
          size="default"
          value={draft.direction}
          onChange={(event) =>
            onChange({
              ...draft,
              direction: event.target.value === "inflow" ? "inflow" : "outflow",
            })
          }
        >
          <NativeSelectOption value="outflow">Gasto</NativeSelectOption>
          <NativeSelectOption value="inflow">Ingreso</NativeSelectOption>
        </NativeSelect>
      </div>
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
    <Input
      id="correction-notes"
      maxLength={2000}
      value={draft.notes}
      onChange={(event) => onChange({ ...draft, notes: event.target.value })}
    />
  </div>
);
const CorrectionFeedback = ({
  status,
  onRefresh,
}: Readonly<{ status: CorrectionStatus; onRefresh: () => void }>): JSX.Element => (
  <>
    {status === "invalid" ? (
      <p role="alert" className="text-sm text-destructive">
        Revisa el monto, la fecha y la categoría.
      </p>
    ) : null}
    {status === "rejected" ? (
      <div role="alert">
        <p className="text-sm">
          No se guardaron los cambios. Actualiza el historial y vuelve a abrir la transacción para
          revisar su versión actual.
        </p>
        <Button variant="outline" onClick={onRefresh}>
          Actualizar historial
        </Button>
      </div>
    ) : null}
    {status === "uncertain" ? (
      <div role="alert">
        <p className="text-sm">
          No pudimos confirmar los cambios. Actualiza el historial y revisa la transacción antes de
          volver a editarla.
        </p>
        <Button variant="outline" onClick={onRefresh}>
          Actualizar historial
        </Button>
      </div>
    ) : null}
  </>
);
const OptionalNotes = ({
  draft,
  onChange,
}: Readonly<{
  draft: CorrectionDraft;
  onChange: (draft: CorrectionDraft) => void;
}>): JSX.Element => (
  <details>
    <summary className="cursor-pointer text-sm text-muted-foreground">Notas (opcional)</summary>
    <div className="pt-2">
      <DraftNotes draft={draft} onChange={onChange} />
    </div>
  </details>
);
const CorrectionActions = ({
  status,
  locked,
  onCancel,
}: Readonly<{
  status: CorrectionStatus;
  locked: boolean;
  onCancel: () => void;
}>): JSX.Element => (
  <div className="grid grid-cols-2 gap-3">
    <Button type="button" variant="outline" disabled={status === "saving"} onClick={onCancel}>
      Cancelar
    </Button>
    <Button type="submit" disabled={locked}>
      {status === "saving" ? "Guardando…" : "Guardar cambios"}
    </Button>
  </div>
);
/** Corrects only explicitly changed facts at the observed revision; an uncertain write is never replayed. */
export const TransactionCorrection = (props: CorrectionProps): JSX.Element => {
  const [draft, setDraft] = useState(() => initialDraft(props.transaction, props.timeZone));
  const { status, onStatus: setStatus } = props;
  const [command] = useState(() => makeCorrection(props.apiClient, props.transaction));
  const submit = useAtomSet(command);
  const locked = status === "saving" || status === "uncertain" || status === "rejected";
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked) return;
    const changes = correctionChanges(draft, props);
    if (Option.isNone(changes)) {
      setStatus("invalid");
      return;
    }
    if (Object.keys(changes.value).length === 0) {
      props.onCancel();
      return;
    }
    setStatus("saving");
    submit({
      changes: changes.value,
      onSaved: props.onSaved,
      onRejected: () => setStatus("rejected"),
      onUncertain: () => setStatus("uncertain"),
    });
  };
  return props.renderForm(
    <form aria-label="Corregir transacción" onSubmit={onSubmit} className="flex flex-col gap-5">
      <div>
        <h3 className="text-xl font-semibold">Corregir transacción</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Corrige esta transacción sin crear otra.
        </p>
      </div>
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-5">
        <legend className="sr-only">Datos de la transacción</legend>
        <DraftDescription
          draft={draft}
          currency={props.transaction.money.currency}
          categories={props.categories}
          onChange={setDraft}
        />
        <DraftInputs
          draft={draft}
          currency={props.transaction.money.currency}
          categories={props.categories}
          onChange={setDraft}
        />
        <OptionalNotes draft={draft} onChange={setDraft} />
      </fieldset>
      <CorrectionFeedback status={status} onRefresh={props.onRefresh} />
      <CorrectionActions status={status} locked={locked} onCancel={props.onCancel} />
    </form>
  );
};
