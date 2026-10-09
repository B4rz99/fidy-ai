import { browserCrypto } from "@/browser/crypto";
import { useAtomSet } from "@effect/atom-react";
import type * as Atom from "effect/reactivity/Atom";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { Array as Arr, BigDecimal, Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  AtomicBatchCallId,
  AtomicBatchRejected,
  type CanonicalInput,
  type FidyClient,
} from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
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
type BatchInput = CanonicalInput<"operations.executeAtomicBatch">;
type Changes = CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
type BulkProps = Readonly<{
  transactions: Arr.NonEmptyReadonlyArray<Transaction>;
  categories: ReadonlyArray<Category>;
  apiClient: FidyClient;
  timeZone: string;
  status: CorrectionStatus;
  onStatus: (status: CorrectionStatus) => void;
  onSaved: () => void;
  onCancel: () => void;
  onRefresh: () => void;
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
const batchInput = (
  changes: Changes,
  transactions: ReadonlyArray<Pick<Transaction, "id" | "revision">>
): Option.Option<BatchInput> => {
  const calls = transactions.map((record) => ({
    callId: Schema.decodeSync(AtomicBatchCallId)(
      Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie))
    ),
    operation: "transactions.updateTransaction",
    input: { params: { id: record.id }, payload: { expectedRevision: record.revision, changes } },
  }));
  if (
    !Arr.isReadonlyArrayNonEmpty(calls) ||
    !calls.every((call) => isCanonicalInput("transactions.updateTransaction", call.input))
  ) {
    return Option.none();
  }
  const input = { payload: { calls } };
  return isCanonicalInput("operations.executeAtomicBatch", input)
    ? Option.some(input)
    : Option.none();
};
type BulkCommand = Readonly<{
  input: BatchInput;
  onSaved: () => void;
  onRejected: () => void;
  onUncertain: () => void;
}>;
const makeBulkCorrection = (apiClient: FidyClient): Atom.AtomResultFn<BulkCommand, void, never> =>
  apiClient.runtime.fn<BulkCommand>()((command) =>
    Effect.gen(function* () {
      const client = yield* apiClient;
      yield* client.operations.executeAtomicBatch(command.input);
      yield* Effect.sync(command.onSaved);
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(
          Schema.is(AtomicBatchRejected)(failure) ? command.onRejected : command.onUncertain
        )
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(command.onUncertain)
      )
    )
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
      <Label htmlFor="bulk-amount">Monto ($)</Label>
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
const BulkFields = ({
  draft,
  onChange,
  props,
  locked,
}: Readonly<{
  draft: BulkDraft;
  onChange: (draft: BulkDraft) => void;
  props: BulkProps;
  locked: boolean;
}>): JSX.Element => (
  <fieldset disabled={locked} className="flex min-w-0 flex-col gap-5">
    <legend className="sr-only">Cambios para las transacciones seleccionadas</legend>
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
    <div className="flex flex-col gap-2">
      <Label htmlFor="bulk-counterparty">Contraparte</Label>
      <Input
        id="bulk-counterparty"
        placeholder="Sin cambiar"
        maxLength={200}
        value={draft.counterparty}
        onChange={(event) => onChange({ ...draft, counterparty: event.target.value })}
      />
    </div>
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
      <Input
        id="bulk-notes"
        placeholder="Sin cambiar"
        maxLength={2000}
        value={draft.notes}
        onChange={(event) => onChange({ ...draft, notes: event.target.value })}
      />
    </div>
  </>
);
const BulkFeedback = ({ props }: Readonly<{ props: BulkProps }>): JSX.Element => (
  <>
    {props.status === "invalid" ? <p role="alert">Revisa los campos que quieres cambiar.</p> : null}
    {props.status === "rejected" || props.status === "uncertain" ? (
      <div role="alert">
        <p>
          {props.status === "rejected"
            ? "No se guardó ningún cambio. Actualiza el historial y revisa la selección."
            : "No pudimos confirmar los cambios. Actualiza el historial antes de volver a editar."}
        </p>
        <Button variant="outline" onClick={props.onRefresh}>
          Actualizar historial
        </Button>
      </div>
    ) : null}
  </>
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
  const observedRevisions = props.transactions.map(({ id, revision }) => ({ id, revision }));
  const [command] = useState(() => makeBulkCorrection(props.apiClient));
  const submit = useAtomSet(command);
  const locked =
    props.status === "saving" || props.status === "uncertain" || props.status === "rejected";
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked) return;
    const changes = draftChanges(draft, props);
    if (Option.isNone(changes) || Object.keys(changes.value).length === 0) {
      props.onStatus("invalid");
      return;
    }
    const input = batchInput(changes.value, observedRevisions);
    if (Option.isNone(input)) {
      props.onStatus("invalid");
      return;
    }
    props.onStatus("saving");
    submit({
      input: input.value,
      onSaved: props.onSaved,
      onRejected: () => props.onStatus("rejected"),
      onUncertain: () => props.onStatus("uncertain"),
    });
  };
  return props.renderForm(
    <form
      aria-label="Editar transacciones seleccionadas"
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
    >
      <h2 className="text-xl font-semibold">Editar {observedRevisions.length} transacciones</h2>
      <p className="text-sm text-muted-foreground">
        Los campos vacíos o sin cambiar conservan su valor en cada transacción.
      </p>
      <BulkFields draft={draft} onChange={setDraft} props={props} locked={locked} />
      <BulkFeedback props={props} />
      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" disabled={props.status === "saving"} onClick={props.onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={locked}>
          {props.status === "saving" ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </form>
  );
};
