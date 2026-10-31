import type { JSX } from "react";
import { Skeleton } from "./skeleton";

export const ReviewOriginalLinesSkeleton = (): JSX.Element => (
  <div className="grid gap-[12px] py-[18px]">
    {[0, 1, 2, 3].map((line) => (
      <Skeleton key={line} className="h-[16px] w-full last:w-2/3" />
    ))}
  </div>
);
