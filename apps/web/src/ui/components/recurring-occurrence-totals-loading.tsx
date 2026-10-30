import type { JSX } from "react";
import { Skeleton } from "./skeleton";

export const RecurringOccurrenceTotalsSkeleton = (): JSX.Element => (
  <footer className="flex flex-wrap items-center justify-between gap-4 border-t bg-muted/40 px-5 py-3">
    <Skeleton className="h-[1lh] w-36 text-sm" />
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      {[0, 1, 2].map((kind) => (
        <div key={kind} className="grid gap-1 text-right text-xs">
          <Skeleton className="h-[1lh] w-20" />
          <Skeleton className="h-[1lh] w-20" />
        </div>
      ))}
    </div>
  </footer>
);
