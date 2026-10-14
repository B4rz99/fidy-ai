import { type JSX, useState } from "react";
import { AmountInput } from "@/ui/components/amount-input";
import { BudgetMeter } from "@/ui/components/budget-meter";
import { FinancialSummaryCard } from "@/ui/components/financial-summary-card";
import { Label } from "@/ui/components/label";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";

const currencies = ["COP", "EUR", "JPY", "KWD", "USD", "AED"].map((value) => ({
  value,
  label: value,
}));
export const FinancialReference = (): JSX.Element => {
  const [amount, setAmount] = useState("9876543210.99");
  const [currency, setCurrency] = useState("COP");
  return (
    <section aria-label="Controles financieros" className="flex flex-col gap-4">
      <h2 className="text-2xl font-semibold">Controles financieros</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <FinancialSummaryCard
          ariaLabel="Resumen positivo de ejemplo"
          amount="$ 19.876.542.960,20"
          label="Ingresos sin asignar"
          tone="positive"
        >
          <div className="flex flex-col gap-3 p-4">
            <p>Plan de gastos: $ 3.880.000,00</p>
            <BudgetMeter value={60} over={false} variant="summary" label="Gastos del ejemplo" />
          </div>
        </FinancialSummaryCard>
        <FinancialSummaryCard
          ariaLabel="Resumen excedido de ejemplo"
          amount="$ 250,00"
          label="El plan supera los ingresos recibidos"
          tone="negative"
        >
          <div className="flex flex-col gap-3 p-4">
            <p>$ 30,00 excedido</p>
            <BudgetMeter value={100} over variant="summary" label="Gastos excedidos del ejemplo" />
          </div>
        </FinancialSummaryCard>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="reference-financial-amount">Importe de ejemplo</Label>
        <AmountInput
          id="reference-financial-amount"
          width="content"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
      <AmountStates />
      <SearchableChoiceDropdown
        id="reference-searchable-currency"
        label="Moneda de ejemplo"
        value={currency}
        options={currencies}
        disabled={false}
        width="full"
        onChange={setCurrency}
      />
    </section>
  );
};

const AmountStates = (): JSX.Element => (
  <>
    <div className="flex flex-col gap-2">
      <Label htmlFor="reference-disabled-amount">Importe deshabilitado</Label>
      <AmountInput width="full" id="reference-disabled-amount" disabled value="250" />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="reference-invalid-amount">Importe con error</Label>
      <AmountInput
        width="full"
        id="reference-invalid-amount"
        aria-invalid="true"
        readOnly
        value=""
      />
    </div>
  </>
);
