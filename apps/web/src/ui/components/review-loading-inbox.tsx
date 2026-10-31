import type { JSX } from "react";
import { Skeleton } from "./skeleton";
import { ReviewDetailContentSkeleton } from "./review-loading-content";

export const ReviewInboxContentSkeleton = (): JSX.Element => (
  <div data-review="grid">
    <aside data-review="inbox">
      <div data-review="inbox-head">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-12" />
      </div>
      <div data-review="inbox-rows">
        {[0, 1, 2].map((row) => (
          <div key={row} data-review="inbox-row">
            <Skeleton className="mt-[5px] size-4 shrink-0" />
            <div data-review="row-content">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-[21px] w-full" />
              <Skeleton className="h-[18px] w-24" />
              <Skeleton className="h-[23px] w-32" />
            </div>
          </div>
        ))}
      </div>
      <div data-review="pager">
        <Skeleton className="h-[34px] w-20" />
        <Skeleton className="h-[34px] w-20" />
      </div>
    </aside>
    <section data-review="detail">
      <div data-review="detail-heading">
        <div data-review="item-heading">
          <Skeleton className="size-[42px] rounded-full" />
          <div className="grid gap-1">
            <Skeleton className="h-[27px] w-44" />
            <Skeleton className="h-[18px] w-32" />
          </div>
        </div>
        <Skeleton className="h-6 w-28" />
      </div>
      <ReviewDetailContentSkeleton />
    </section>
  </div>
);
