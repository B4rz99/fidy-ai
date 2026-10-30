import type { JSX } from "react";
import { Skeleton } from "./skeleton";
import { ReviewFieldSkeleton } from "./review-loading-field";
import { ReviewOriginalLinesSkeleton } from "./review-loading-original";

export const ReviewDetailContentSkeleton = (): JSX.Element => (
  <>
    <div data-review="columns">
      <div data-review="original">
        <div className="flex items-center justify-between border-b pb-[15px]">
          <Skeleton className="h-[20px] w-32" />
          <Skeleton className="size-4" />
        </div>
        <ReviewOriginalLinesSkeleton />
        <div data-review="original-footer">
          <Skeleton className="h-[18px] w-full" />
        </div>
      </div>
      <div data-review="form">
        <Skeleton className="h-[65px] w-full" />
        <div data-review="fields">
          <ReviewFieldSkeleton />
          <div className="grid grid-cols-2 items-start gap-3">
            <ReviewFieldSkeleton />
            <ReviewFieldSkeleton />
          </div>
          <div>
            <div data-review="occurrence" className="grid grid-cols-2 gap-3">
              <ReviewFieldSkeleton />
              <ReviewFieldSkeleton />
            </div>
            <Skeleton className="mt-2 h-[15px] w-40" />
          </div>
          <div data-review="classification" className="grid gap-3">
            <ReviewFieldSkeleton />
            <ReviewFieldSkeleton />
          </div>
        </div>
      </div>
    </div>
    <footer data-review="footer">
      <div data-review="footer-main">
        <Skeleton className="h-[15px] w-28" />
        <div data-review="footer-actions">
          <Skeleton className="h-11 w-20" />
          <Skeleton className="h-11 w-28" />
        </div>
      </div>
      <p>
        <Skeleton className="h-4 w-3/4" />
      </p>
    </footer>
  </>
);
