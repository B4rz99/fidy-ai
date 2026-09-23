import { useAtomSet } from "@effect/atom-react";
import { BigDecimal, DateTime, Effect, Option } from "effect";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { Button } from "@/ui/components/button";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";

type CapturedTransaction = CanonicalSuccess<"transactions.createTransaction">["data"];

type CaptureCommand = Readonly<{
  amount: string;
  counterparty: string;
  direction: "inflow" | "outflow";
  occurredOn: string;
  timeZone: string;
  onSaved: (transaction: CapturedTransaction) => void;
  onFailed: () => void;
}>;

const makeCapture = (apiClient: FidyClient): Atom.AtomResultFn<CaptureCommand, void, never> =>
  apiClient.runtime.fn<CaptureCommand>()(
    (command) => {
      const amount = BigDecimal.fromString(command.amount);
      const zoned = DateTime.makeZoned(`${command.occurredOn}T00:00:00.000Z`, {
        timeZone: command.timeZone,
        adjustForTimeZone: true,
      });
      if (
        Option.isNone(amount) ||
        Option.isNone(zoned) ||
        DateTime.formatIsoDate(zoned.value) !== command.occurredOn
      ) {
        return Effect.sync(command.onFailed);
      }
      return Effect.gen(function* () {
        const client = yield* apiClient;
        const created = yield* client.transactions.createTransaction({
          payload: {
            money: { amount: amount.value, currency: "COP" },
            direction: command.direction,
            counterparty: Option.fromNullishOr(command.counterparty.trim() || undefined),
            notes: Option.none(),
            categoryId: Option.none(),
            occurredAt: DateTime.toUtc(zoned.value),
          },
        });
        yield* Effect.sync(() => command.onSaved(created.data));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed)));
    },
    { concurrent: false }
  );

type CaptureInputsProps = Readonly<{
  amount: string;
  counterparty: string;
  occurredOn: string;
  onAmount: (value: string) => void;
  onCounterparty: (value: string) => void;
  onOccurredOn: (value: string) => void;
}>;
const CaptureInputs = ({
  amount,
  counterparty,
  occurredOn,
  onAmount,
  onCounterparty,
  onOccurredOn,
}: CaptureInputsProps): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="transaction-amount">Monto en COP</Label>
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
      <Input
        id="transaction-date"
        required
        type="date"
        value={occurredOn}
        onChange={(event) => onOccurredOn(event.target.value)}
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
    <select
      id="transaction-direction"
      className="border-input bg-background h-9 rounded-md border px-3"
      value={value}
      onChange={(event) => onChange(event.target.value === "inflow" ? "inflow" : "outflow")}
    >
      <option value="outflow">Salida</option>
      <option value="inflow">Entrada</option>
    </select>
  </div>
);

const currentLocalDay = (timeZone: string): string =>
  DateTime.formatIsoDate(
    DateTime.setZone(Effect.runSync(DateTime.now), DateTime.zoneMakeNamedUnsafe(timeZone))
  );

/** Captures one browser-initiated Transaction through the generated canonical client. */
export const ManualTransactionCapture = ({
  apiClient,
  onCreated,
  timeZone,
}: Readonly<{
  apiClient: FidyClient;
  onCreated: (transaction: CapturedTransaction) => void;
  timeZone: string;
}>): JSX.Element => {
  const [capture] = useState(() => makeCapture(apiClient));
  const submit = useAtomSet(capture);
  const [amount, setAmount] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [occurredOn, setOccurredOn] = useState(() => currentLocalDay(timeZone));
  const [direction, setDirection] = useState<"inflow" | "outflow">("outflow");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (status === "saving") return;
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
    });
  };
  return (
    <form onSubmit={onSubmit} aria-label="Registrar transacción" className="rounded-lg border p-4">
      <div className="flex flex-col gap-4">
        <CaptureInputs
          amount={amount}
          counterparty={counterparty}
          occurredOn={occurredOn}
          onAmount={setAmount}
          onCounterparty={setCounterparty}
          onOccurredOn={setOccurredOn}
        />
        <CaptureDirection value={direction} onChange={setDirection} />
        <Button type="submit" disabled={status === "saving"}>
          {status === "saving" ? "Guardando…" : "Registrar transacción"}
        </Button>
        {status === "saved" ? (
          <output>Transacción guardada. Actualizando el historial…</output>
        ) : null}
        {status === "failed" ? (
          <p role="alert">No se pudo guardar la transacción. Intenta de nuevo.</p>
        ) : null}
      </div>
    </form>
  );
};
