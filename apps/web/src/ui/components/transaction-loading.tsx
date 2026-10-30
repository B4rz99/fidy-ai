import type { JSX, ReactNode } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import { Table, TableBody, TableCell, TableRow } from "./table";
import "./transactions.css";

const placeholderRows = 6;
const LedgerRows = (): JSX.Element => (
  <div className="transaction-ledger" data-category-visible="false" data-type-visible="false">
    <Table>
      <TableBody>
        <TableRow data-date-group="true">
          <TableCell colSpan={2}>
            <div>
              <Skeleton className="h-[18px] w-32" />
            </div>
          </TableCell>
        </TableRow>
        {Array.from({ length: placeholderRows }, (_, row) => (
          <TableRow key={row}>
            <TableCell>
              <div className="flex min-w-0 items-center gap-3">
                <Skeleton className="transaction-identity-icon size-8 shrink-0 rounded-full" />
                <div className="grid flex-1 gap-1">
                  <Skeleton className="h-[21px] w-44 max-w-full" />
                  <Skeleton className="transaction-category-inline h-[17px] w-24" />
                </div>
              </div>
            </TableCell>
            <TableCell>
              <Skeleton className="h-[20px] w-24" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);
export const TransactionRowsSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando transacciones">
    <LedgerRows />
  </LoadingRegion>
);
const SummarySkeleton = (): JSX.Element => (
  <section data-transaction-slot="transaction-summary">
    <h2>
      <Skeleton className="h-[29px] w-24" />
    </h2>
    <span data-transaction-slot="transaction-summary-currency">
      <Skeleton className="h-[17px] w-8" />
    </span>
    <dl data-transaction-slot="transaction-summary-totals">
      {[0, 1].map((figure) => (
        <div key={figure}>
          <dt>
            <Skeleton className="h-[20px] w-36" />
          </dt>
          <dd>
            <Skeleton className="h-[39px] w-44" />
          </dd>
        </div>
      ))}
    </dl>
    <p data-transaction-slot="transaction-summary-count">
      <Skeleton className="h-[18px] w-full" />
    </p>
    <dl data-transaction-slot="transaction-summary-facts">
      {[0, 1, 2].map((fact) => (
        <div key={fact}>
          <dt>
            <Skeleton className="h-[18px] w-28" />
          </dt>
          <dd>
            <Skeleton className="h-[18px] w-20" />
          </dd>
        </div>
      ))}
    </dl>
    <dl data-transaction-slot="transaction-summary-facts">
      {[0, 1].map((fact) => (
        <div key={fact}>
          <dt>
            <Skeleton className="h-[18px] w-28" />
          </dt>
          <dd>
            <Skeleton className="h-[18px] w-20" />
          </dd>
        </div>
      ))}
    </dl>
  </section>
);
export const TransactionsSkeleton = ({
  readOnly,
  notice,
}: Readonly<{ readOnly: boolean; notice: ReactNode }>): JSX.Element => (
  <LoadingRegion label="Cargando transacciones">
    <div data-transaction-slot="transaction-workspace" data-panel-open="false">
      <header data-transaction-slot="transaction-page-header">
        <h1>Transacciones</h1>
        {readOnly ? null : <Skeleton className="h-[46px] w-28" />}
      </header>
      <div inert>{notice}</div>
      <div data-transaction-slot="transaction-columns">
        <div data-transaction-slot="transaction-records">
          <div data-transaction-slot="transaction-search-toolbar">
            <Skeleton className="h-11 min-w-0 flex-1" />
            <Skeleton className="size-11" />
            <Skeleton className="h-11 w-36" />
            <Skeleton className="size-11" />
          </div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <Skeleton className="h-11 w-48" />
            <div className="ledger-actions flex gap-2">
              <Skeleton className="h-[38px] w-28" />
              <Skeleton className="h-[38px] w-24" />
              <Skeleton className="h-[38px] w-24" />
            </div>
          </div>
          <LedgerRows />
        </div>
        <aside data-transaction-slot="transaction-context-panel">
          <SummarySkeleton />
        </aside>
      </div>
    </div>
  </LoadingRegion>
);
