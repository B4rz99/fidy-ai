import type { JSX, ReactNode } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import "./dashboard.css";

const WidgetFrame = ({
  kind,
  children,
}: Readonly<{ kind: string; children: ReactNode }>): JSX.Element => (
  <section data-slot="card" className="dashboard-card" data-widget-type={kind}>
    <header className="dashboard-card-header">
      <Skeleton className="h-[26px] w-40" />
    </header>
    <div className="dashboard-card-content">{children}</div>
  </section>
);
const FiguresWidget = (): JSX.Element => (
  <WidgetFrame kind="custom-metric">
    <div className="dashboard-figures">
      <Skeleton className="dashboard-currency h-[22px] w-8" />
      <dl className="dashboard-figure-values">
        {[0, 1].map((figure) => (
          <div key={figure}>
            <dt>
              <Skeleton className="h-5 w-20" />
            </dt>
            <dd>
              <Skeleton className="h-10 w-40" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  </WidgetFrame>
);
const BudgetWidget = (): JSX.Element => (
  <WidgetFrame kind="budget-bar">
    <div className="dashboard-budget">
      <Skeleton className="h-[22px] w-8" />
      <div className="dashboard-budget-labels">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="dashboard-budget-values">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-6 w-28" />
      </div>
      <Skeleton className="h-2 w-full" />
      <div className="dashboard-budget-status">
        <Skeleton className="h-5 w-12" />
        <Skeleton className="h-5 w-36" />
      </div>
    </div>
  </WidgetFrame>
);
const ChartWidget = (): JSX.Element => (
  <WidgetFrame kind="spending-chart">
    <Skeleton className="h-[22px] w-8" />
    <div className="flex h-[300px] items-end gap-4 py-8">
      {[0, 1, 2, 3].map((bar) => (
        <Skeleton key={bar} className="h-3/4 flex-1" />
      ))}
    </div>
    <Skeleton className="h-5 w-48" />
  </WidgetFrame>
);
const RecentWidget = (): JSX.Element => (
  <WidgetFrame kind="transaction-list">
    <div className="dashboard-recent-group">
      <Skeleton className="mb-3 h-5 w-28" />
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="dashboard-recent-row">
          <div className="dashboard-recent-identity">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="grid gap-1">
              <Skeleton className="h-[21px] w-32" />
              <Skeleton className="h-[18px] w-24" />
            </div>
          </div>
          <Skeleton className="h-[21px] w-24" />
        </div>
      ))}
    </div>
  </WidgetFrame>
);
export const DashboardSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando tablero">
    <main className="dashboard-surface">
      <header className="dashboard-header">
        <Skeleton className="h-[45px] w-52" />
        <Skeleton className="h-[46px] w-36" />
      </header>
      <div className="relative flex min-h-[calc(100svh-11.25rem)] flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-5.5">
          <div className="flex flex-1 flex-col gap-5.5 lg:flex-row">
            <ChartWidget />
            <BudgetWidget />
          </div>
          <div className="flex flex-1 flex-col gap-5.5 lg:flex-row">
            <RecentWidget />
            <FiguresWidget />
          </div>
        </div>
      </div>
    </main>
  </LoadingRegion>
);

export const DashboardCatalogSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando catálogo del tablero">
    <section className="grid gap-3 rounded-xl border bg-background p-4">
      <h2 className="font-medium">Widgets disponibles</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((entry) => (
          <div
            key={entry}
            className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3"
          >
            <div className="grid flex-1 gap-2">
              <Skeleton className="h-[21px] w-28 max-w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
            <Skeleton className="size-8 shrink-0" />
          </div>
        ))}
      </div>
    </section>
  </LoadingRegion>
);
