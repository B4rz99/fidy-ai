import type { JSX } from "react";
import { Skeleton } from "./skeleton";
import { RecurringOccurrenceDesktopSkeleton } from "./recurring-occurrence-desktop-loading";
import { RecurringOccurrenceCompactSkeleton } from "./recurring-occurrence-compact-loading";
import { RecurringOccurrenceTotalsSkeleton } from "./recurring-occurrence-totals-loading";

export const RecurringOccurrenceSkeleton = (): JSX.Element => (
  <section data-recurring-slot="occurrence-group" className="@container min-w-0">
    <h2>
      <div className="flex w-full items-center gap-2 py-[13px] text-[15px] leading-normal">
        <Skeleton className="size-4" />
        <Skeleton className="h-[1lh] w-32" />
        <Skeleton className="size-4" />
      </div>
    </h2>
    <RecurringOccurrenceDesktopSkeleton />
    <RecurringOccurrenceCompactSkeleton />
    <RecurringOccurrenceTotalsSkeleton />
  </section>
);
