import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import { WorkspaceColumns, WorkspaceHeader } from "./workspace-layout";
import { WorkspacePanel } from "./workspace-panel";
import "./budget-layout.css";
import "./financial-summary-card.css";

const BudgetFigures = (): JSX.Element => (
  <>
    {[0, 1, 2].map((figure) => (
      <div key={figure} className="budget-value">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-11 w-28" />
      </div>
    ))}
  </>
);
const BudgetRows = (): JSX.Element => (
  <div className="budget-table-container">
    <div className="budget-table gap-4">
      <div className="budget-head budget-tracks gap-4 rounded-md bg-muted px-4 py-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
      {[0, 1].map((group) => (
        <section key={group} className="budget-group gap-3 border-b pb-4">
          <header className="budget-group-heading budget-tracks items-center gap-4 px-4 py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="size-5" />
              <Skeleton className="h-6 w-40" />
            </div>
            <div className="budget-group-figures">
              <BudgetFigures />
            </div>
          </header>
          {[0, 1].map((row) => (
            <div key={row} className="budget-row gap-4 border-t px-4 py-4">
              <div className="budget-row-label flex min-w-0 items-center gap-2">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="size-8" />
              </div>
              <BudgetFigures />
              <div className="budget-progress pl-4">
                <Skeleton className="h-2 w-full" />
              </div>
            </div>
          ))}
        </section>
      ))}
      <div className="budget-totals rounded-lg border bg-card px-4 py-4">
        <h2>
          <Skeleton className="h-6 w-36" />
        </h2>
        <div className="budget-figures gap-4">
          <Skeleton className="h-5 w-12" />
          <BudgetFigures />
        </div>
      </div>
    </div>
  </div>
);
const BudgetSummary = (): JSX.Element => (
  <div className="financial-summary-card overflow-hidden rounded-lg border bg-card">
    <div className="mx-4 mt-4 grid justify-items-center gap-2 rounded-md bg-muted px-3 py-6">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-5 w-44" />
    </div>
    <div className="flex justify-around gap-2 px-3 py-4">
      {[0, 1, 2].map((tab) => (
        <Skeleton key={tab} className="h-9 w-20" />
      ))}
    </div>
    {[0, 1].map((section) => (
      <div key={section} className="grid gap-3 border-t px-4 py-5">
        <div className="flex justify-between gap-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-24" />
        </div>
        <Skeleton className="h-2 w-full" />
      </div>
    ))}
  </div>
);
export const BudgetSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando presupuestos">
    <WorkspaceHeader title="Presupuestos" context={<Skeleton className="mt-1 h-5 w-32" />}>
      <Skeleton className="size-11" />
      <Skeleton className="size-11" />
      <Skeleton className="h-11 w-16" />
      <Skeleton className="h-11 w-28" />
    </WorkspaceHeader>
    <div>
      <WorkspaceColumns
        variant="container"
        panel={
          <WorkspacePanel
            open={false}
            locked
            onClose={() => undefined}
            title="Resumen del mes"
            description=""
          >
            <BudgetSummary />
          </WorkspacePanel>
        }
      >
        <BudgetRows />
      </WorkspaceColumns>
    </div>
  </LoadingRegion>
);
