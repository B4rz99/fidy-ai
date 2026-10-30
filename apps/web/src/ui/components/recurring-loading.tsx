import type { JSX } from "react";
import { RecurringHeaderSkeleton } from "./recurring-header-loading";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import { RecurringMonthControlsSkeleton } from "./recurring-month-controls-loading";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";
import "./recurring.css";

const MonthlySummary = (): JSX.Element => (
  <section data-recurring-slot="monthly-overview">
    <RecurringMonthControlsSkeleton />
    <div data-recurring-slot="summary">
      {[0, 1, 2].map((kind) => (
        <section key={kind} data-recurring-slot="summary-kind">
          <h3>
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-5 w-20" />
          </h3>
          <div data-recurring-slot="summary-amounts" className="grid gap-2">
            <div data-recurring-slot="summary-planned">
              <span>
                <Skeleton className="h-4 w-8" />
              </span>
              <strong>
                <Skeleton className="h-[33px] w-36" />
              </strong>
            </div>
            <Skeleton className="h-[7px] w-full" />
            <div className="flex justify-between gap-3">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-4 w-2/5" />
            </div>
          </div>
        </section>
      ))}
    </div>
  </section>
);
const OccurrenceRows = (): JSX.Element => (
  <section data-recurring-slot="occurrence-group">
    <h2 className="py-[13px]">
      <Skeleton className="h-[23px] w-32" />
    </h2>
    <Table>
      <TableHeader>
        <TableRow>
          {[0, 1, 2, 3].map((column) => (
            <TableHead key={column}>
              <Skeleton className="h-[18px] w-20" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {[0, 1, 2].map((row) => (
          <TableRow key={row}>
            <TableCell>
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="grid gap-1">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-20" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-24" />
            </TableCell>
            <TableCell>
              <Skeleton data-slot="button" className="h-9 w-28" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </section>
);
export const RecurringSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando recurrentes">
    <div data-recurring-slot="workspace">
      <RecurringHeaderSkeleton />
      <div data-recurring-slot="columns" data-panel-open="false">
        <main data-recurring-slot="content">
          <div data-recurring-slot="suggestions">
            <Skeleton className="h-[49px] w-full" />
          </div>
          <MonthlySummary />
          <OccurrenceRows />
        </main>
      </div>
    </div>
  </LoadingRegion>
);

export const HistoricalSuggestionsSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando patrones históricos">
    <div className="mt-3 grid gap-3">
      <Skeleton className="h-5 w-2/3" />
      {[0, 1].map((suggestion) => (
        <article key={suggestion} className="grid gap-3 border-t py-4">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-2">
            <Skeleton className="h-[21px] w-full" />
            <Skeleton className="h-[21px] w-4/5" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-11 w-40" />
            <Skeleton className="h-11 w-44" />
          </div>
        </article>
      ))}
    </div>
  </LoadingRegion>
);
