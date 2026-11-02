import { MoneyField } from "./money-field";
import { parseMoneyInput } from "@/transport/money-input";
import { RefreshButton } from "@/ui/components/refresh-button";
import type { Category } from "./presentation";
import { useAtomSet } from "@effect/atom-react";
import { Cause, DateTime, Effect, Option, Predicate } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { Button } from "@/ui/components/button";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";
import { CalendarField } from "@/ui/components/calendar-field";
import { TransactionTypeToggle } from "@/ui/components/transactions";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import type { CanonicalInput, CanonicalSuccess, FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";

export type CaptureStatus = "idle" | "saving" | "saved" | "failed" | "uncertain";

type CapturedTransaction = CanonicalSuccess<"transactions.createTransaction">["data"];

type CaptureCommand = Readonly<{
  amount: string;
  currency: CanonicalInput<"transactions.createTransaction">["payload"]["money"]["currency"];
  counterparty: string;
  notes: string;
  categoryId: Option.Option<Category["id"]>;
  direction: "inflow" | "outflow";
  occurredOn: string;
  timeZone: string;
  onSaved: (transaction: CapturedTransaction) => void;
  onFailed: () => void;
  onUncertain: () => void;
}>;

const makeCapture = (apiClient: FidyClient): Atom.AtomResultFn<CaptureCommand, void, never> =>
  apiClient.runtime
    .fn<CaptureCommand>()(
      (command) => {
        const money = parseMoneyInput({ text: command.amount, currency: command.currency });
        const zoned = DateTime.makeZoned(`${command.occurredOn}T00:00:00.000Z`, {
          timeZone: command.timeZone,
          adjustForTimeZone: true,
        });
        if (
          Option.isNone(money) ||
          Option.isNone(zoned) ||
          DateTime.formatIsoDate(zoned.value) !== command.occurredOn
        ) {
          return Effect.sync(command.onFailed);
        }
        const input: CanonicalInput<"transactions.createTransaction"> = {
          payload: {
            money: money.value,
            direction: command.direction,
            counterparty: Option.fromNullishOr(command.counterparty.trim() || undefined),
            notes: Option.fromNullishOr(command.notes.trim() || undefined),
            categoryId: command.categoryId,
            occurredAt: DateTime.toUtc(zoned.value),
          },
        };
        if (!isCanonicalInput("transactions.createTransaction", input)) {
          return Effect.sync(command.onFailed);
        }
        return Effect.gen(function* () {
          const client = yield* apiClient;
          const created = yield* client.transactions.createTransaction(input);
          yield* Effect.sync(() => command.onSaved(created.data));
        }).pipe(
          Effect.catch((failure) =>
            Effect.sync(
              Predicate.isTagged(failure, "ValidationFailed") ||
                Predicate.isTagged(failure, "NotFound") ||
                Predicate.isTagged(failure, "ResourceLimited")
                ? command.onFailed
                : command.onUncertain
            )
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(command.onUncertain)
          )
        );
      },
      { concurrent: false }
    )
    .pipe(Atom.keepAlive);

type CaptureInputsProps = Readonly<{
  amount: string;
  counterparty: string;
  currency: CaptureCommand["currency"];
  onAmount: (value: string) => void;
  onCounterparty: (value: string) => void;
}>;
const CaptureInputs = ({
  amount,
  counterparty,
  onAmount,
  onCounterparty,
  currency,
}: CaptureInputsProps): JSX.Element => (
  <>
    <MoneyField
      id="transaction-amount"
      currency={currency}
      currencyLabel={currency}
      required
      disabled={false}
      value={amount}
      onChange={onAmount}
    />
    <div className="flex flex-col gap-2">
      <Label htmlFor="transaction-counterparty">Contraparte (opcional)</Label>
      <Input
        id="transaction-counterparty"
        maxLength={120}
        placeholder="Nombre del comercio o persona"
        value={counterparty}
        onChange={(event) => onCounterparty(event.target.value)}
      />
    </div>
  </>
);

const currentLocalDay = (timeZone: string): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(Effect.runSync(DateTime.now), DateTime.zoneMakeNamedUnsafe(timeZone))
  );

const CaptureFeedback = ({
  status,
  onCheckHistory,
}: Readonly<{ status: CaptureStatus; onCheckHistory: () => void }>): JSX.Element => (
  <>
    {status === "saved" ? <output>Transacción guardada.</output> : null}
    {status === "uncertain" ? (
      <div>
        <p role="alert">
          No pudimos confirmar el registro de la transacción. Revisa el historial antes de registrar
          otro movimiento.
        </p>
        <RefreshButton
          type="button"
          onClick={onCheckHistory}
          variant="outline"
          label="Actualizar historial"
        />
      </div>
    ) : null}
    {status === "failed" ? (
      <p role="alert">No se pudo guardar la transacción. Intenta de nuevo.</p>
    ) : null}
  </>
);

const CaptureNotes = ({
  notes,
  setNotes,
}: Readonly<{ notes: string; setNotes: (value: string) => void }>): JSX.Element => (
  <div className="flex flex-col gap-2" data-transaction-slot="transaction-capture-notes">
    <Label htmlFor="transaction-notes">Notas (opcional)</Label>
    <textarea
      id="transaction-notes"
      maxLength={500}
      placeholder="Añadir una nota"
      value={notes}
      onChange={(event) => setNotes(event.target.value)}
    />
  </div>
);
const CaptureClassification = ({
  categories,
  categoryId,
  setCategoryId,
  notes,
  setNotes,
  occurredOn,
  timeZone,
  onOccurredOn,
}: Readonly<{
  categories: ReadonlyArray<Category>;
  categoryId: string;
  setCategoryId: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  occurredOn: string;
  timeZone: string;
  onOccurredOn: (value: string) => void;
}>): JSX.Element => (
  <>
    <div className="flex flex-col gap-2" data-transaction-slot="transaction-capture-category">
      <Label htmlFor="transaction-category">Categoría</Label>
      <ChoiceDropdown
        triggerLabel={Option.none()}
        id="transaction-category"
        label="Categoría"
        width="full"
        leading={null}
        disabled={false}
        value={categoryId}
        options={[
          { value: "", label: "Asignar automáticamente" },
          ...categories.map((category) => ({ value: category.id, label: category.label })),
        ]}
        onChange={setCategoryId}
      />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="transaction-date">Fecha</Label>
      <CalendarField
        id="transaction-date"
        label="Fecha"
        required
        timeZone={timeZone}
        disabled={false}
        appearance="field"
        value={occurredOn}
        onChange={onOccurredOn}
      />
    </div>
    <CaptureNotes notes={notes} setNotes={setNotes} />
  </>
);
type CaptureProps = Readonly<{
  categories: ReadonlyArray<Category>;
  onCancel: Option.Option<() => void>;
  renderForm: (form: JSX.Element) => JSX.Element;
  apiClient: FidyClient;
  onCreated: (transaction: CapturedTransaction) => void;
  timeZone: string;
  onCheckHistory: () => void;
  status: CaptureStatus;
  currency: CaptureCommand["currency"];
  initial: Partial<Omit<CaptureDraft, "direction">>;
  direction: Option.Option<CaptureDraft["direction"]>;
  disabled: boolean;
  onStatus: (status: CaptureStatus) => void;
}>;
type CaptureDraft = Readonly<{
  amount: string;
  counterparty: string;
  notes: string;
  categoryId: string;
  occurredOn: string;
  direction: "inflow" | "outflow";
}>;
const CaptureForm = ({
  props,
  draft,
  onDraft,
  onSubmit,
}: Readonly<{
  props: CaptureProps;
  draft: CaptureDraft;
  onDraft: (draft: CaptureDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}>): JSX.Element => {
  const locked =
    props.disabled === true || props.status === "saving" || props.status === "uncertain";
  return (
    <form onSubmit={onSubmit} aria-label="Registrar transacción" className="flex flex-col gap-5">
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Datos de la transacción</legend>
        {Option.isNone(props.direction) ? (
          <TransactionTypeToggle
            value={draft.direction}
            onChange={(direction) => onDraft({ ...draft, direction })}
          />
        ) : (
          <p>{draft.direction === "inflow" ? "Ingreso" : "Gasto"}</p>
        )}
        <CaptureInputs
          amount={draft.amount}
          currency={props.currency}
          counterparty={draft.counterparty}
          onAmount={(amount) => onDraft({ ...draft, amount })}
          onCounterparty={(counterparty) => onDraft({ ...draft, counterparty })}
        />
        <CaptureClassification
          categories={props.categories}
          occurredOn={draft.occurredOn}
          timeZone={props.timeZone}
          onOccurredOn={(occurredOn) => onDraft({ ...draft, occurredOn })}
          categoryId={draft.categoryId}
          setCategoryId={(categoryId) => onDraft({ ...draft, categoryId })}
          notes={draft.notes}
          setNotes={(notes) => onDraft({ ...draft, notes })}
        />
      </fieldset>
      <CaptureFeedback status={props.status} onCheckHistory={props.onCheckHistory} />
      <CaptureActions props={props} amount={draft.amount} />
    </form>
  );
};
const CaptureActions = ({
  props,
  amount,
}: Readonly<{ props: CaptureProps; amount: string }>): JSX.Element => (
  <div data-transaction-slot="transaction-form-actions">
    {Option.isNone(props.onCancel) ? null : (
      <Button
        type="button"
        variant="outline"
        disabled={props.status === "saving"}
        onClick={Option.getOrUndefined(props.onCancel)}
      >
        Cancelar
      </Button>
    )}
    <Button
      type="submit"
      disabled={
        props.disabled ||
        props.status === "saving" ||
        props.status === "uncertain" ||
        Option.isNone(parseMoneyInput({ text: amount, currency: props.currency }))
      }
    >
      {props.status === "saving" ? "Guardando…" : "Registrar"}
    </Button>
  </div>
);

export const TransactionCapture = (props: CaptureProps): JSX.Element => {
  const [capture] = useState(() => makeCapture(props.apiClient));
  const submit = useAtomSet(capture);
  const admission = useRef(false);
  const [draft, setDraft] = useState<CaptureDraft>(() => ({
    amount: "",
    counterparty: "",
    notes: "",
    categoryId: "",
    direction: Option.getOrElse(props.direction, () => "outflow"),
    occurredOn: currentLocalDay(props.timeZone),
    ...props.initial,
  }));
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (
      admission.current ||
      props.disabled ||
      props.status === "saving" ||
      props.status === "uncertain" ||
      Option.isNone(parseMoneyInput({ text: draft.amount, currency: props.currency }))
    ) {
      return;
    }
    admission.current = true;
    props.onStatus("saving");
    submit({
      ...draft,
      currency: props.currency,
      categoryId: Option.fromNullishOr(
        props.categories.find((category) => category.id === draft.categoryId)
      ).pipe(Option.map((category) => category.id)),
      timeZone: props.timeZone,
      onSaved: (transaction) => {
        props.onStatus("saved");
        setDraft({ ...draft, amount: "", counterparty: "", notes: "", categoryId: "" });
        props.onCreated(transaction);
      },
      onFailed: () => {
        admission.current = false;
        props.onStatus("failed");
      },
      onUncertain: () => props.onStatus("uncertain"),
    });
  };
  return props.renderForm(
    <CaptureForm props={props} draft={draft} onDraft={setDraft} onSubmit={onSubmit} />
  );
};
