import type { JSX } from "react";
import { Skeleton } from "./skeleton";

export const ReviewFieldSkeleton = (): JSX.Element => (
  <div className="grid content-start gap-2.5">
    <Skeleton className="h-[18px] w-28" />
    <Skeleton className="h-[45px] w-full" />
  </div>
);
