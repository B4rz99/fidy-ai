import type { JSX } from "react";
import { Skeleton } from "./skeleton";

export const RecurringIdentitySkeleton = (): JSX.Element => (
  <div className="flex min-w-0 flex-1 items-center gap-3">
    <Skeleton className="size-10 shrink-0 rounded-full" />
    <div className="min-w-0 flex-1">
      <Skeleton className="h-[1lh] w-full max-w-32" />
      <Skeleton className="h-4 w-full max-w-20" />
    </div>
  </div>
);
