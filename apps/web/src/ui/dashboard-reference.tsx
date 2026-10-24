import "@/ui/components/application.css";
import { Option } from "effect";
import type { JSX } from "react";
import {
  DashboardBudget,
  DashboardCard,
  DashboardFigures,
  DashboardRecentList,
} from "@/ui/components/dashboard";

export const DashboardReference = (): JSX.Element => (
  <section
    id="dashboard"
    aria-label="Componentes del tablero"
    className="application-shell grid gap-6"
  >
    <h2>Componentes del tablero</h2>
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
    <DashboardCard title={<h2>Transacciones recientes</h2>} editing={false} kind="transaction-list">
      <DashboardRecentList
        groups={[
          {
            date: "24 de octubre de 2026",
            rows: [
              {
                id: "example",
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
