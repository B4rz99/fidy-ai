import { type JSX, useState } from "react";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { FinancialSummaryCard } from "@/ui/components/financial-summary-card";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { BudgetMeter } from "@/ui/components/budget-meter";
import { ToggleGroup, ToggleGroupItem } from "@/ui/components/toggle-group";
import { cn } from "@/ui/class-names";
import {
  type BudgetReport,
  type CurrentUser,
  type SummaryFigure,
  summaryFigures,
} from "./presentation";

const currencyPillLimit = 5;

type SummaryView = "summary" | "income" | "expenses";

export const BudgetSummary = ({
  report,
  user,
}: Readonly<{ report: BudgetReport; user: CurrentUser }>): JSX.Element => {
  const [view, setView] = useState<SummaryView>("summary");
  const [currency, setCurrency] = useState("");
  const figures = summaryFigures({ report, locale: user.locale });
  const figure = figures.find((item) => item.currency === currency) ?? figures[0];
  return (
    <div className="flex flex-col gap-4">
      <h2 className="sr-only">Resumen del mes</h2>
      {figures.length > 1 ? (
        <SummaryCurrency
          figures={figures}
          currency={figure?.currency ?? ""}
          onChange={setCurrency}
        />
      ) : null}
      {figure !== undefined ? (
        <FinancialSummaryCard
          ariaLabel={`Resumen ${figure.currency}`}
          amount={figure.allocationAmount}
          label={allocationLabel(figure)}
          tone={allocationTone(figure)}
        >
          <SummaryTabs view={view} onChange={setView} />
          {view !== "expenses" ? <IncomeSummary figure={figure} /> : null}
          {view !== "income" ? <ExpenseSummary figure={figure} /> : null}
        </FinancialSummaryCard>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Todavía no hay actividad este mes.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
};

const SummaryTabs = ({
  view,
  onChange,
}: Readonly<{
  view: SummaryView;
  onChange: (view: SummaryView) => void;
}>): JSX.Element => (
  <div className="px-3 py-4">
    <ToggleGroup
      aria-label="Vista del resumen"
      value={[view]}
      className="w-full flex-wrap justify-around"
      onValueChange={(values) => {
        const next = values[0];
        if (next === "summary" || next === "income" || next === "expenses") {
          onChange(next);
        }
      }}
    >
      <ToggleGroupItem variant="summary" value="summary">
        Resumen
      </ToggleGroupItem>
      <ToggleGroupItem variant="summary" value="income">
        Ingresos
      </ToggleGroupItem>
      <ToggleGroupItem variant="summary" value="expenses">
        Gastos
      </ToggleGroupItem>
    </ToggleGroup>
  </div>
);

const IncomeSummary = ({ figure }: Readonly<{ figure: SummaryFigure }>): JSX.Element => (
  <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-foreground/5 px-4 py-5 text-sm">
    <h3 className="text-muted-foreground">Ingresos recibidos</h3>
    <p className="tabular-nums">{figure.income}</p>
  </div>
);

const ExpenseSummary = ({ figure }: Readonly<{ figure: SummaryFigure }>): JSX.Element => (
  <div className="flex flex-col gap-3 border-t border-foreground/5 px-4 py-5">
    <div className="flex flex-wrap items-baseline justify-between gap-3 text-sm">
      <h3 className="text-muted-foreground">Gastos</h3>
      <span className="text-muted-foreground tabular-nums">Plan de gastos: {figure.budgeted}</span>
    </div>
    <BudgetMeter
      variant="summary"
      value={figure.percentage}
      over={figure.over}
      label={`Gastos ${figure.currency}`}
    />
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs tracking-tight tabular-nums">
      <p>
        {figure.expenses} <span className="text-muted-foreground">gastados</span>
      </p>
      <p className={cn("font-medium", figure.over ? "text-error-foreground" : "text-ring")}>
        {figure.remaining} {figure.over ? "excedido" : "restantes"}
      </p>
    </div>
  </div>
);

const SummaryCurrency = ({
  figures,
  currency,
  onChange,
}: Readonly<{
  figures: ReadonlyArray<SummaryFigure>;
  currency: string;
  onChange: (currency: string) => void;
}>): JSX.Element => {
  if (figures.length > currencyPillLimit) {
    return (
      <SearchableChoiceDropdown
        id="budget-summary-currency"
        label="Moneda del resumen"
        value={currency}
        options={figures.map((item) => ({ value: item.currency, label: item.currency }))}
        disabled={false}
        width="full"
        onChange={onChange}
      />
    );
  }
  return (
    <ToggleGroup
      aria-label="Moneda del resumen"
      value={[currency]}
      onValueChange={(values) => {
        if (values[0] !== undefined && values[0] !== "") onChange(values[0]);
      }}
    >
      {figures.map((item) => (
        <ToggleGroupItem key={item.currency} variant="summary" value={item.currency}>
          {item.currency}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

const allocationLabel = (figure: SummaryFigure): string =>
  figure.overallocated ? "El plan supera los ingresos recibidos" : "Ingresos sin asignar";
const allocationTone = (figure: SummaryFigure): "negative" | "positive" =>
  figure.overallocated ? "negative" : "positive";
