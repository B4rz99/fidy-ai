import { TransactionCaptureRecovery } from "@/ui/components/transaction-capture-recovery";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { type JSX, useState } from "react";
import { AmountInput } from "@/ui/components/amount-input";
import { Label } from "@/ui/components/label";
import { Button } from "@/ui/components/button";
import {
  TransactionContextPanel,
  TransactionSurface,
  TransactionTypeToggle,
} from "@/ui/components/transactions";

const currencyExamples = [
  {
    value: "COP",
    label: "COP",
    hint: "Usa punto para miles y coma para decimales. Máximo 2 decimales.",
  },
  {
    value: "USD",
    label: "USD",
    hint: "Usa punto para miles y coma para decimales. Máximo 2 decimales.",
  },
  { value: "JPY", label: "JPY", hint: "Usa punto para miles. JPY no admite decimales." },
];

export const TransactionsReference = (): JSX.Element => {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("COP");
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
              <Button>Registrar</Button>
            </div>
          </form>
          <Button variant="outline" data-transaction-slot="transaction-danger">
            Eliminar
          </Button>
        </TransactionContextPanel>
      </TransactionSurface>
      <CaptureRecoveryReference />
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
  currency: string;
  setCurrency: (value: string) => void;
}>): JSX.Element => (
  <>
    <Label htmlFor="reference-transaction-currency">Moneda</Label>
    <SearchableChoiceDropdown
      id="reference-transaction-currency"
      label="Moneda"
      value={currency}
      options={currencyExamples}
      disabled={false}
      width="full"
      onChange={setCurrency}
    />
    <Label htmlFor="reference-transaction-amount">Monto</Label>
    <AmountInput
      id="reference-transaction-amount"
      value={amount}
      onChange={(event) => setAmount(event.target.value)}
      width="full"
      placeholder="0,00"
      aria-describedby="reference-transaction-amount-help"
    />
    <p id="reference-transaction-amount-help" className="text-sm text-muted-foreground">
      {currencyExamples.find((example) => example.value === currency)?.hint}
    </p>
    <p className="text-sm text-muted-foreground">
      El monto se registra en la moneda elegida, sin conversión.
    </p>
  </>
);

const CaptureRecoveryReference = (): JSX.Element => {
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <section
      aria-label="Recuperación de registro de ejemplo"
      className="mt-6 flex max-w-sm flex-col gap-4"
    >
      <h2>Borrador por revisar</h2>
      <p>Ejemplo local con datos ficticios. Ninguna acción crea o elimina transacciones.</p>
      <TransactionCaptureRecovery
        fields={[
          { label: "Monto", value: "COP 12.345,67" },
          { label: "Tipo", value: "Gasto" },
          { label: "Fecha", value: "07-11-2026" },
          { label: "Contraparte", value: "Tienda La Esquina" },
          { label: "Categoría", value: "Alimentación" },
          { label: "Notas", value: "Compra para la cena" },
        ]}
        checked={checked}
        waiting={false}
        onCheck={() => {
          setChecked(true);
          setMessage("Historial de ejemplo actualizado. Compara antes de continuar.");
        }}
        onResume={() =>
          setMessage(
            "La aplicación abre los datos conservados para editarlos antes de un nuevo registro explícito."
          )
        }
        onDiscard={() => {
          setChecked(false);
          setMessage("Borrador de ejemplo descartado. El historial no cambia.");
        }}
        onHistory={() => setMessage("Puedes revisar el historial y volver al borrador conservado.")}
      />
      <output>{message}</output>
    </section>
  );
};
