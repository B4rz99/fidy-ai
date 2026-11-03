import { Currency } from "@/transport/client";
import { Option, Schema } from "effect";
import { SearchableChoiceDropdown } from "./components/searchable-choice-dropdown";
import { moneyInputHint, parseMoneyInput } from "@/transport/money-input";
import { type JSX, useState } from "react";
import { AmountInput } from "@/ui/components/amount-input";
import { Label } from "@/ui/components/label";
import { Button } from "@/ui/components/button";
import {
  TransactionContextPanel,
  TransactionSurface,
  TransactionTypeToggle,
} from "@/ui/components/transactions";

export const TransactionsReference = (): JSX.Element => {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("COP");
  const [type, onType] = useState<"inflow" | "outflow">("outflow");
  return (
    <section aria-label="Composición aprobada de transacciones">
      <TransactionSurface panelOpen={false}>
        <header data-transaction-slot="transaction-page-header">
          <h1>Transacciones</h1>
          <Button>+ Registrar</Button>
        </header>
        <TransactionContextPanel
          title="Campos de ejemplo"
          identity="example"
          active={false}
          locked={false}
          onClose={() => {}}
        >
          <h2>Registrar transacción</h2>
          <form className="mt-5 flex flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
            <TransactionTypeToggle value={type} onChange={onType} />
            <ReferenceMoneyFields
              amount={amount}
              setAmount={setAmount}
              currency={currency}
              setCurrency={setCurrency}
            />
            <Label htmlFor="reference-transaction-notes">Notas (opcional)</Label>
            <textarea
              id="reference-transaction-notes"
              maxLength={500}
              placeholder="Añadir una nota"
            />
            <div data-transaction-slot="transaction-form-actions">
              <Button variant="outline">Cancelar</Button>
              <Button disabled={Option.isNone(parseMoneyInput({ text: amount, currency }))}>
                Registrar
              </Button>
            </div>
          </form>
          <Button variant="outline" data-transaction-slot="transaction-danger">
            Eliminar
          </Button>
        </TransactionContextPanel>
      </TransactionSurface>
    </section>
  );
};

const ReferenceMoneyFields = ({
  amount,
  setAmount,
  currency,
  setCurrency,
}: Readonly<{
  amount: string;
  setAmount: (value: string) => void;
  currency: Currency;
  setCurrency: (value: Currency) => void;
}>): JSX.Element => (
  <>
    <Label htmlFor="reference-transaction-currency">Moneda</Label>
    <SearchableChoiceDropdown
      id="reference-transaction-currency"
      label="Moneda"
      value={currency}
      options={Currency.literals.map((value) => ({ value, label: value }))}
      disabled={false}
      width="full"
      onChange={(value) => {
        const selected = Schema.decodeUnknownOption(Currency)(value);
        if (Option.isSome(selected)) setCurrency(selected.value);
      }}
    />
    <Label htmlFor="reference-transaction-amount">Monto</Label>
    <AmountInput
      id="reference-transaction-amount"
      value={amount}
      onChange={(event) => setAmount(event.target.value)}
      width="full"
      placeholder="0,00"
      aria-describedby="reference-transaction-amount-help"
      aria-invalid={amount !== "" && Option.isNone(parseMoneyInput({ text: amount, currency }))}
    />
    <p id="reference-transaction-amount-help" className="text-sm text-muted-foreground">
      {moneyInputHint(currency)}
    </p>
    <p className="text-sm text-muted-foreground">
      El monto se registra en la moneda elegida, sin conversión.
    </p>
  </>
);
