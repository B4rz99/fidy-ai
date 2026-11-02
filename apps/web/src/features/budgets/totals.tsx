import type { JSX } from "react";
import { BudgetBalance } from "@/ui/components/budget-meter";
import { type BudgetReport, summaryFigures } from "./presentation";

export const BudgetTotals = ({
  report,
  locale,
}: Readonly<{ report: BudgetReport; locale: string }>): JSX.Element => (
  <div className="budget-totals rounded-lg border bg-card px-4 py-4">
    <h2 className="font-semibold">Gasto total del mes</h2>
    {summaryFigures({ report, locale }).map((figure) => (
      <section
        key={figure.currency}
        aria-label={`Gasto total del mes ${figure.currency}`}
        className="budget-tracks mt-3 gap-3 border-t pt-3"
      >
        <p className="col-span-full font-medium">{figure.currency}</p>
        <p className="col-span-full text-sm">
          Con presupuesto: {figure.budgetedExpenses} + sin presupuesto: {figure.unbudgetedExpenses}{" "}
          = {figure.expenses}
        </p>
        <span>Total del mes</span>
        <span className="budget-value text-right tabular-nums">
          <span className="budget-value-label">Presupuesto</span>
          {figure.budgeted}
        </span>
        <span className="budget-value text-right tabular-nums">
          <span className="budget-value-label">Gastado</span>
          {figure.expenses}
        </span>
        <span className="budget-value text-right tabular-nums">
          <span className="budget-value-label">
            {figure.over ? "Excedido" : "Restante del plan"}
          </span>
          <BudgetBalance over={figure.over}>{figure.remaining}</BudgetBalance>
        </span>
      </section>
    ))}
  </div>
);
