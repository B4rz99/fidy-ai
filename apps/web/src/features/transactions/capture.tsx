import { type CaptureDraft, emptyCaptureDraft } from "./capture-draft";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { Currency } from "@/transport/client";
import { MoneyField } from "./money-field";
import { parseMoneyInput } from "@/transport/money-input";
import { RefreshButton } from "@/ui/components/refresh-button";
import type { Category } from "./presentation";
import { useAtomValue } from "@effect/atom-react";
import { Data, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import type { FormEvent, JSX, ReactNode, RefCallback } from "react";
import { Button } from "@/ui/components/button";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";
import { CalendarField } from "@/ui/components/calendar-field";
import { TransactionTypeToggle } from "@/ui/components/transactions";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import {
  type CaptureRetention,
  type TransactionCaptureTask,
  makeCaptureRetention,
} from "./capture-task";

type CaptureInputsProps = Readonly<{
  amount: string;
  counterparty: string;
  currency: CaptureDraft["currency"];
  onAmount: (value: string) => void;
  onCounterparty: (value: string) => void;
  onCurrency: Option.Option<(currency: CaptureDraft["currency"]) => void>;
  disabled: boolean;
  revealErrors: boolean;
}>;
const changeCaptureCurrency = (
  value: string,
  change: (currency: CaptureDraft["currency"]) => void
): void => {
  const selected = Schema.decodeUnknownOption(Currency)(value);
  if (Option.isSome(selected)) change(selected.value);
};
const CaptureInputs = ({
  amount,
  counterparty,
  onAmount,
  onCounterparty,
  currency,
  onCurrency,
  disabled,
  revealErrors,
}: CaptureInputsProps): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      {Option.match(onCurrency, {
        onNone: () => <p className="text-sm">Moneda · {currency}</p>,
        onSome: (change) => (
          <>
            <Label htmlFor="transaction-currency">Moneda</Label>
            <SearchableChoiceDropdown
              rendering="natural"
              id="transaction-currency"
              label="Moneda"
              value={currency}
              options={Currency.literals.map((value) => ({ value, label: value }))}
              disabled={disabled}
              width="full"
              onChange={(value) => changeCaptureCurrency(value, change)}
            />
          </>
        ),
      })}
    </div>
    <div className="flex flex-col gap-2">
      <MoneyField
        revealErrors={revealErrors}
        id="transaction-amount"
        currency={currency}
        label="Monto"
        required
        disabled={false}
        value={amount}
        onChange={onAmount}
      />
      <p className="text-sm text-muted-foreground">
        El monto se registra en la moneda elegida, sin conversión.
      </p>
    </div>
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

const CaptureFeedback = ({
  task,
  onCheckHistory,
}: Readonly<{ task: TransactionCaptureTask; onCheckHistory: () => void }>): JSX.Element => (
  <>
    {Option.isSome(task.created) ? <output>Transacción guardada.</output> : null}
    {task.uncertain ? (
      <div>
        <p role="alert">
          No pudimos confirmar si la transacción se guardó. Actualiza el historial antes de volver a
          registrarla.
        </p>
        <RefreshButton
          type="button"
          onClick={onCheckHistory}
          variant="outline"
          label="Actualizar historial"
        />
      </div>
    ) : null}
    {task.rejected ? (
      <p role="alert">
        No pudimos guardar la transacción. Tus datos siguen en el formulario. Intenta de nuevo.
      </p>
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
  intentId: string;
  categories: ReadonlyArray<Category>;
  onCancel: Option.Option<() => void>;
  renderForm: (
    form: JSX.Element,
    placement: Readonly<{ saving: boolean; uncertain: boolean }>
  ) => JSX.Element;
  apiClient: FidyClient;
  onCreated: (transaction: CanonicalSuccess<"transactions.createTransaction">["data"]) => void;
  timeZone: string;
  onCheckHistory: () => void;
  onInvalidate: () => void;
  currency: Option.Option<CaptureDraft["currency"]>;
  initial: Partial<Omit<CaptureDraft, "direction" | "currency">>;
  direction: Option.Option<CaptureDraft["direction"]>;
  disabled: boolean;
}>;
type EditorProps = Omit<CaptureProps, "intentId" | "renderForm"> &
  Readonly<{ newAttempt: boolean; task: TransactionCaptureTask }>;
const captureLocked = (props: EditorProps): boolean => props.disabled || props.task.locked;
const captureCurrencyChange = (
  fixed: CaptureProps["currency"],
  change: (currency: CaptureDraft["currency"]) => void
): CaptureInputsProps["onCurrency"] => (Option.isSome(fixed) ? Option.none() : Option.some(change));
const CaptureForm = ({
  props,
  draft,
  onDraft,
  onSubmit,
  revealErrors,
  mounted,
}: Readonly<{
  mounted: RefCallback<HTMLFormElement>;
  props: EditorProps;
  draft: CaptureDraft;
  onDraft: (draft: CaptureDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  revealErrors: boolean;
}>): JSX.Element => (
  <form
    ref={mounted}
    noValidate
    onSubmit={onSubmit}
    aria-label="Registrar transacción"
    className="flex flex-col gap-5"
  >
    <fieldset disabled={captureLocked(props)} className="flex min-w-0 flex-col gap-4">
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
        revealErrors={revealErrors}
        amount={draft.amount}
        disabled={captureLocked(props)}
        currency={draft.currency}
        counterparty={draft.counterparty}
        onCurrency={captureCurrencyChange(props.currency, (currency) =>
          onDraft({ ...draft, currency })
        )}
        onAmount={(amount) => onDraft({ ...draft, amount })}
        onCounterparty={(counterparty) => onDraft({ ...draft, counterparty })}
      />
      <CaptureClassification
        categories={props.categories}
        occurredOn={draft.occurredOn}
        timeZone={props.task.timeZone}
        onOccurredOn={(occurredOn) => onDraft({ ...draft, occurredOn })}
        categoryId={draft.categoryId}
        setCategoryId={(categoryId) => onDraft({ ...draft, categoryId })}
        notes={draft.notes}
        setNotes={(notes) => onDraft({ ...draft, notes })}
      />
    </fieldset>
    <CaptureFeedback task={props.task} onCheckHistory={props.onCheckHistory} />
    <CaptureActions props={props} />
  </form>
);

const captureSubmitLabel = (props: EditorProps): string => {
  if (props.task.saving) return "Guardando…";
  return props.newAttempt ? "Registrar como nueva transacción" : "Registrar";
};
const CaptureActions = ({ props }: Readonly<{ props: EditorProps }>): JSX.Element => (
  <div data-transaction-slot="transaction-form-actions">
    {Option.isNone(props.onCancel) ? null : (
      <Button
        type="button"
        variant="outline"
        disabled={props.task.saving}
        onClick={Option.getOrUndefined(props.onCancel)}
      >
        Cancelar
      </Button>
    )}
    <Button type="submit" disabled={captureLocked(props)} contentLayout="wrap">
      {captureSubmitLabel(props)}
    </Button>
  </div>
);

const CaptureEditor = ({ props }: Readonly<{ props: EditorProps }>): JSX.Element => {
  const [attempted, setAttempted] = useState(false);
  const [presentation] = useState(() => ({ active: false }));
  const [mounted] = useState<RefCallback<HTMLFormElement>>(
    () =>
      (
        node: Parameters<RefCallback<HTMLFormElement>>[0]
      ): ReturnType<RefCallback<HTMLFormElement>> => {
        if (node === null) return;
        presentation.active = true;
        return (): void => {
          presentation.active = false;
        };
      }
  );
  const draft = props.task.draft;
  const currency = draft.currency;
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttempted(true);
    if (captureLocked(props)) return;
    if (Option.isNone(parseMoneyInput({ text: draft.amount, currency }))) {
      event.currentTarget.querySelector<HTMLInputElement>("#transaction-amount")?.focus();
      return;
    }
    if (!event.currentTarget.reportValidity()) return;
    props.task.submit({
      categories: props.categories,
      onCreated: (created) => {
        if (presentation.active) props.onCreated(created);
      },
      invalidate: () => {
        if (presentation.active) props.onInvalidate();
      },
    });
  };
  return (
    <CaptureForm
      mounted={mounted}
      revealErrors={attempted}
      props={props}
      draft={draft}
      onDraft={props.task.change}
      onSubmit={onSubmit}
    />
  );
};
class CaptureIdentity extends Data.Class<Readonly<{ client: FidyClient; intentId: string }>> {}
const retainedCaptures = Atom.family((_identity: CaptureIdentity) =>
  makeCaptureRetention().pipe(Atom.keepAlive)
);
const captureMeaning = (props: CaptureProps): string =>
  JSON.stringify([
    props.timeZone,
    Option.isSome(props.currency),
    Option.isSome(props.direction),
    Option.getOrElse(props.currency, () => "COP"),
    Option.getOrElse(props.direction, () => "outflow"),
    props.initial.amount ?? "",
    props.initial.occurredOn ?? "",
    props.initial.counterparty ?? "",
    props.initial.notes ?? "",
    props.initial.categoryId ?? "",
  ]);
const CaptureAttachment = ({
  props,
  retention,
  children,
}: Readonly<{
  props: CaptureProps;
  retention: CaptureRetention;
  children: ReactNode;
}>): JSX.Element => {
  const [mounted] = useState<RefCallback<HTMLDivElement>>(
    () =>
      (node: Parameters<RefCallback<HTMLDivElement>>[0]): ReturnType<RefCallback<HTMLDivElement>> =>
        node === null
          ? undefined
          : retention.mount(
              {
                client: props.apiClient,
                timeZone: props.timeZone,
                initial: {
                  ...emptyCaptureDraft(props.timeZone),
                  ...props.initial,
                  currency: Option.getOrElse(props.currency, () => "COP"),
                  direction: Option.getOrElse(props.direction, () => "outflow"),
                },
              },
              captureMeaning(props)
            )
  );
  return (
    <div className="contents" ref={mounted}>
      {children}
    </div>
  );
};
const RetainedCapture = ({
  props,
  intentId,
}: Readonly<{ props: CaptureProps; intentId: string }>): JSX.Element => {
  const identity = new CaptureIdentity({ client: props.apiClient, intentId });
  const retentionResource = retainedCaptures(identity);
  const retention = useAtomValue(retentionResource);
  return Option.match(retention.resource, {
    onNone: () => (
      <CaptureAttachment props={props} retention={retention}>
        {null}
      </CaptureAttachment>
    ),
    onSome: (resource) => (
      <RetainedCaptureEditor props={props} resource={resource} retention={retention} />
    ),
  });
};
const RetainedCaptureEditor = ({
  props,
  resource,
  retention,
}: Readonly<{
  props: CaptureProps;
  resource: Atom.Atom<TransactionCaptureTask>;
  retention: CaptureRetention;
}>): JSX.Element => {
  const task = useAtomValue(resource);
  const identity = task.locked
    ? Option.getOrElse(retention.identity, () => captureMeaning(props))
    : captureMeaning(props);
  return (
    <CaptureAttachment key={identity} props={props} retention={retention}>
      {props.renderForm(<RetainedCaptureForm {...props} />, {
        saving: task.saving,
        uncertain: task.uncertain,
      })}
    </CaptureAttachment>
  );
};
const RetainedCaptureForm = (props: CaptureProps): JSX.Element => {
  const identity = new CaptureIdentity({ client: props.apiClient, intentId: props.intentId });
  const retentionResource = retainedCaptures(identity);
  const retention = useAtomValue(retentionResource);
  return Option.match(retention.resource, {
    onNone: () => <></>,
    onSome: (resource) => <CaptureTaskForm props={props} resource={resource} />,
  });
};
const CaptureTaskForm = ({
  props,
  resource,
}: Readonly<{ props: CaptureProps; resource: Atom.Atom<TransactionCaptureTask> }>): JSX.Element => {
  const task = useAtomValue(resource);
  return <CaptureEditor props={{ ...props, task, newAttempt: false }} />;
};
export const TransactionCapture = (props: CaptureProps): JSX.Element => (
  <RetainedCapture key={props.intentId} props={props} intentId={props.intentId} />
);
export const ControlledTransactionCapture = (props: EditorProps): JSX.Element => (
  <CaptureEditor props={props} />
);
