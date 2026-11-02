import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { BudgetSpending } from "./spending";
import type { WorkspaceProps } from "./model";
import { categoryFor } from "./model";

export const UnbudgetedSpending = ({ props }: Readonly<{ props: WorkspaceProps }>): JSX.Element =>
  props.report.unbudgetedExpenses.length === 0 ? (
    <></>
  ) : (
    <section
      aria-label="Gastos sin presupuesto"
      className="col-span-full rounded-lg border bg-card p-4"
    >
      <h2 className="font-semibold">Gastos sin presupuesto</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Estos gastos no tienen un presupuesto en su moneda. Se incluyen en el gasto total del mes.
      </p>
      {props.report.unbudgetedExpenses.map((expense) => {
        const category = categoryFor({ categories: props.categories, id: expense.categoryId });
        return (
          <div
            key={`${category.id}:${expense.spent.currency}`}
            className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          >
            <span>
              {category.label} · {expense.spent.currency}
            </span>
            <BudgetSpending
              category={category}
              spent={expense.spent}
              period={props.report.period}
              user={props.user}
            />
            {!props.report.statuses.some((status) => status.budget.categoryId === category.id) ? (
              <Button
                variant="outline"
                disabled={props.editing.disabled}
                onClick={() => props.editing.assignCategory(category)}
              >
                Asignar presupuesto
              </Button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
