import { dashboardCategoryVisual } from "@/ui/components/dashboard-category";
import "@/ui/components/application.css";
import { Option } from "effect";
import { type JSX, useId, useState } from "react";
import { Button } from "@/ui/components/button";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { DashboardBudgetDialog } from "@/ui/components/dashboard-budget-dialog";
import { Label } from "@/ui/components/label";
// react-doctor-disable-next-line prefer-dynamic-import
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import {
  DashboardAxisTick,
  DashboardBudget,
  DashboardCard,
  DashboardChart,
  DashboardCurrency,
  DashboardFigures,
  DashboardRecentList,
  DashboardTooltip,
} from "@/ui/components/dashboard";

const spendingExamples = [
  {
    key: "10000000-0000-4000-8000-000000000001",
    label: "Restaurantes",
    outflow: 45000,
    amount: "$ 45.000,00",
  },
  {
    key: "10000000-0000-4000-8000-000000000003",
    label: "Mercado",
    outflow: 90000,
    amount: "$ 90.000,00",
  },
  {
    key: "10000000-0000-4000-8000-000000000004",
    label: "Transporte",
    outflow: 10000,
    amount: "$ 10.000,00",
  },
  {
    key: "10000000-0000-4000-8000-000000000016",
    label: "Otros gastos con nombre largo",
    outflow: 1,
    amount: "$ 1,00",
  },
].map((row) => ({ ...row, fill: dashboardCategoryVisual(row.key).fill }));

const SpendingReference = (): JSX.Element => (
  <DashboardCard title={<h2>Gastos por categoría</h2>} editing={false} kind="spending-chart">
    <section className="dashboard-chart-series" aria-label="Serie COP de ejemplo">
      <span className="dashboard-chart-currency">
        <DashboardCurrency>COP</DashboardCurrency>
      </span>
      <span className="dashboard-chart-legend">Gastos</span>
      <DashboardChart categoryCount={4}>
        <BarChart responsive width="100%" height="100%" accessibilityLayer data={spendingExamples}>
          <CartesianGrid vertical={false} stroke="var(--application-line)" />
          <XAxis
            dataKey="key"
            interval={0}
            axisLine={false}
            tickLine={false}
            tickMargin={16}
            height={80}
            tick={<DashboardAxisTick category labels={spendingExamples} />}
          />
          <DashboardTooltip
            labelFormatter={(key) => spendingExamples.find((row) => row.key === key)?.label ?? ""}
            formatter={(value) => [
              spendingExamples.find((row) => row.outflow === value)?.amount ?? "No disponible",
              "Gastos",
            ]}
          />
          <Bar dataKey="outflow" radius={4} maxBarSize={52} />
        </BarChart>
      </DashboardChart>
      <div className="dashboard-chart-footer">noviembre de 2026 · COP · Datos de ejemplo</div>
    </section>
  </DashboardCard>
);

export const DashboardReference = (): JSX.Element => (
  <section
    id="dashboard"
    aria-label="Componentes del tablero"
    className="application-shell grid gap-6"
  >
    <h2>Componentes del tablero</h2>
    <SpendingReference />
    <DashboardCard title={<h2>Salidas del mes</h2>} editing={false} kind="custom-metric">
      <DashboardFigures currency="COP" inflow="$ 3.800.000,00" outflow="$ 1.845.000,00" />
    </DashboardCard>
    <DashboardCard title={<h2>Presupuesto de restaurantes</h2>} editing={false} kind="budget-bar">
      <DashboardBudget
        category="Restaurantes"
        currency="COP"
        spent="$ 640.000,00"
        cap="$ 1.000.000,00"
        progress={64}
        utilization={Option.some("64 % utilizado")}
        status="Disponible $ 360.000,00"
        over={false}
      />
    </DashboardCard>
    <BudgetConfigurationReference />
    <DashboardCard title={<h2>Transacciones recientes</h2>} editing={false} kind="transaction-list">
      <DashboardRecentList
        groups={[
          {
            date: "24 de octubre de 2026",
            rows: [
              {
                id: "example",
                date: "2026-10-24",
                counterparty: "Mercado de ejemplo",
                category: "Mercado",
                inflow: false,
                money: "$ 82.500,00",
                currency: "COP",
              },
            ],
          },
        ]}
      />
    </DashboardCard>
  </section>
);

const BudgetConfigurationReference = (): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("usd");
  const [saved, setSaved] = useState("Restaurantes · COP");
  const id = useId();
  const options = [
    { value: "usd", label: "Restaurantes · USD" },
    { value: "cop", label: "Mercado · COP" },
  ];
  return (
    <div className="grid justify-items-start gap-3">
      <p>Configuración de ejemplo: {saved}</p>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Configurar presupuesto
      </Button>
      <DashboardBudgetDialog open={open} onClose={() => setOpen(false)}>
        <form
          className="grid gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(options.find(({ value }) => value === target)?.label ?? saved);
            setOpen(false);
          }}
        >
          <div className="grid gap-3">
            <Label htmlFor={id}>Presupuesto</Label>
            <ChoiceDropdown
              id={id}
              label="Presupuesto"
              value={target}
              options={options}
              disabled={false}
              width="full"
              leading={null}
              onChange={setTarget}
              triggerLabel={Option.none()}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Verás el presupuesto y los gastos del mes actual en su moneda original.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit">Guardar cambios</Button>
          </div>
        </form>
      </DashboardBudgetDialog>
    </div>
  );
};
