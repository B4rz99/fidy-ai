import type { CaptureStatus } from "./panel-state";
import { useAtomSet } from "@effect/atom-react";
import { BigDecimal, Cause, DateTime, Effect, Option, Predicate } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { Button } from "@/ui/components/button";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";
import { TransactionDateField } from "./date-field";
import { TransactionDropdown } from "./dropdown";
import type { CanonicalInput, CanonicalSuccess, FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";

type CapturedTransaction = CanonicalSuccess<"transactions.createTransaction">["data"];

type CaptureCommand = Readonly<{
  amount: string;
  counterparty: string;
  direction: "inflow" | "outflow";
  occurredOn: string;
  timeZone: string;
  onSaved: (transaction: CapturedTransaction) => void;
  onFailed: () => void;
  onUncertain: () => void;
}>;

const makeCapture = (apiClient: FidyClient): Atom.AtomResultFn<CaptureCommand, void, never> =>
  apiClient.runtime.fn<CaptureCommand>()(
    (command) => {
      const amount = BigDecimal.fromString(command.amount.trim().replace(",", "."));
      const zoned = DateTime.makeZoned(`${command.occurredOn}T00:00:00.000Z`, {
        timeZone: command.timeZone,
        adjustForTimeZone: true,
      });
      if (
        Option.isNone(amount) ||
        !BigDecimal.isPositive(amount.value) ||
        Option.isNone(zoned) ||
        DateTime.formatIsoDate(zoned.value) !== command.occurredOn
      ) {
        return Effect.sync(command.onFailed);
      }
      const input: CanonicalInput<"transactions.createTransaction"> = {
        payload: {
          money: { amount: amount.value, currency: "COP" },
          direction: command.direction,
          counterparty: Option.fromNullishOr(command.counterparty.trim() || undefined),
          notes: Option.none(),
          categoryId: Option.none(),
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
  );

type CaptureInputsProps = Readonly<{
  amount: string;
  counterparty: string;
  occurredOn: string;
  timeZone: string;
  onAmount: (value: string) => void;
  onCounterparty: (value: string) => void;
  onOccurredOn: (value: string) => void;
}>;
const CaptureInputs = ({
  amount,
  counterparty,
  occurredOn,
  timeZone,
  onAmount,
  onCounterparty,
  onOccurredOn,
}: CaptureInputsProps): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="transaction-amount">Monto ($)</Label>
      <Input
        id="transaction-amount"
        required
        inputMode="decimal"
        value={amount}
        onChange={(event) => onAmount(event.target.value)}
      />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="transaction-date">Fecha del movimiento</Label>
      <TransactionDateField
        id="transaction-date"
        label="Fecha del movimiento"
        required
        timeZone={timeZone}
        disabled={false}
        appearance="field"
        value={occurredOn}
        onChange={onOccurredOn}
      />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="transaction-counterparty">Contraparte (opcional)</Label>
      <Input
        id="transaction-counterparty"
        value={counterparty}
        onChange={(event) => onCounterparty(event.target.value)}
      />
    </div>
  </>
);

const CaptureDirection = ({
  value,
  onChange,
}: Readonly<{
  value: "inflow" | "outflow";
  onChange: (value: "inflow" | "outflow") => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <Label htmlFor="transaction-direction">Dirección</Label>
    <TransactionDropdown
      triggerLabel={Option.none()}
      id="transaction-direction"
      label="Dirección"
      width="full"
      leading={null}
      disabled={false}
      value={value}
      options={[
        { value: "outflow", label: "Gasto" },
        { value: "inflow", label: "Ingreso" },
      ]}
      onChange={(next) => onChange(next === "inflow" ? "inflow" : "outflow")}
    />
  </div>
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
        <Button type="button" onClick={onCheckHistory} variant="outline">
          Actualizar historial
        </Button>
      </div>
    ) : null}
    {status === "failed" ? (
      <p role="alert">No se pudo guardar la transacción. Intenta de nuevo.</p>
    ) : null}
  </>
);

/** Captures one browser-initiated Transaction through the generated canonical client. */
type CaptureProps = Readonly<{
  renderForm: (form: JSX.Element) => JSX.Element;
  apiClient: FidyClient;
  onCreated: (transaction: CapturedTransaction) => void;
  timeZone: string;
  onCheckHistory: () => void;
  status: CaptureStatus;
  onStatus: (status: CaptureStatus) => void;
}>;
export const ManualTransactionCapture = ({
  apiClient,
  renderForm,
  onCreated,
  timeZone,
  onCheckHistory,
  status,
  onStatus: setStatus,
}: CaptureProps): JSX.Element => {
  const [capture] = useState(() => makeCapture(apiClient));
  const submit = useAtomSet(capture);
  const [amount, setAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [occurredOn, setOccurredOn] = useState(() => currentLocalDay(timeZone));
  const [direction, setDirection] = useState<"inflow" | "outflow">("outflow");
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (status === "saving" || status === "uncertain") return;
    setStatus("saving");
    submit({
      amount,
      counterparty,
      occurredOn,
      timeZone,
      direction,
      onSaved: (transaction) => {
        setStatus("saved");
        setAmount("");
        setCounterparty("");
        onCreated(transaction);
      },
      onFailed: () => setStatus("failed"),
      onUncertain: () => setStatus("uncertain"),
    });
  };
  return renderForm(
    <form onSubmit={onSubmit} aria-label="Registrar transacción" className="flex flex-col gap-5">
      <fieldset
        disabled={status === "saving" || status === "uncertain"}
        className="flex min-w-0 flex-col gap-4"
      >
        <legend className="sr-only">Datos de la transacción</legend>
        <CaptureInputs
          amount={amount}
          counterparty={counterparty}
          occurredOn={occurredOn}
          timeZone={timeZone}
          onAmount={setAmount}
          onCounterparty={setCounterparty}
          onOccurredOn={setOccurredOn}
        />
        <CaptureDirection value={direction} onChange={setDirection} />
        <Button type="submit" disabled={status === "saving" || status === "uncertain"}>
          {status === "saving" ? "Guardando…" : "Registrar transacción"}
        </Button>
      </fieldset>
      <CaptureFeedback status={status} onCheckHistory={onCheckHistory} />
    </form>
  );
};
