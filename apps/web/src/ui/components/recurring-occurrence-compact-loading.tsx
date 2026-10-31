import type { JSX } from "react";
import { Skeleton } from "./skeleton";
import { RecurringIdentitySkeleton } from "./recurring-identity-loading";

export const RecurringOccurrenceCompactSkeleton = (): JSX.Element => (
  <div className="divide-y @min-5xl:hidden">
    {[0, 1, 2].map((row) => (
      <div
        key={row}
        className="grid w-full min-w-0 gap-3 px-4 py-3 @min-2xl:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="min-w-0">
          <RecurringIdentitySkeleton />
          <div className="mt-1 pl-12">
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="min-w-0 text-xs tabular-nums @min-2xl:text-right">
          <Skeleton className="h-[1lh] w-24" />
        </div>
      </div>
    ))}
  </div>
);
