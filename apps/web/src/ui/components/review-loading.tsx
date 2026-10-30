import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import { WorkspaceHeader } from "./workspace-layout";
import "./review-workspace.css";

const ReviewField = (): JSX.Element => (
  <div className="grid content-start gap-2.5">
    <Skeleton className="h-[18px] w-28" />
    <Skeleton className="h-[45px] w-full" />
  </div>
);
const OriginalLines = (): JSX.Element => (
  <div className="grid gap-[12px] py-[18px]">
    {[0, 1, 2, 3].map((line) => (
      <Skeleton key={line} className="h-[16px] w-full last:w-2/3" />
    ))}
  </div>
);
const DetailContent = (): JSX.Element => (
  <>
    <div data-review="columns">
      <div data-review="original">
        <div className="flex items-center justify-between border-b pb-[15px]">
          <Skeleton className="h-[20px] w-32" />
          <Skeleton className="size-4" />
        </div>
        <OriginalLines />
        <div data-review="original-footer">
          <Skeleton className="h-[18px] w-full" />
        </div>
      </div>
      <div data-review="form">
        <Skeleton className="h-[65px] w-full" />
        <div data-review="fields">
          <ReviewField />
          <div className="grid grid-cols-2 items-start gap-3">
            <ReviewField />
            <ReviewField />
          </div>
          <div>
            <div data-review="occurrence" className="grid grid-cols-2 gap-3">
              <ReviewField />
              <ReviewField />
            </div>
            <Skeleton className="mt-2 h-[15px] w-40" />
          </div>
          <div data-review="classification" className="grid gap-3">
            <ReviewField />
            <ReviewField />
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
export const ReviewDetailSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando elemento">
    <DetailContent />
  </LoadingRegion>
);
const InboxContent = (): JSX.Element => (
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
      <DetailContent />
    </section>
  </div>
);
export const ReviewInboxSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando elementos">
    <InboxContent />
  </LoadingRegion>
);
export const ReviewPageSkeleton = (): JSX.Element => (
  <LoadingRegion label="Cargando elementos">
    <div data-review="workspace">
      <WorkspaceHeader title="Por revisar" context={null}>
        {null}
      </WorkspaceHeader>
      <div data-review="navigation">
        <div data-review="tabs">
          <Skeleton className="h-[46px] w-24" />
          <Skeleton className="h-[46px] w-20" />
        </div>
        <div data-review="filters">
          <Skeleton className="h-11 w-40" />
          <Skeleton className="h-11 w-[210px]" />
          <Skeleton className="size-11" />
        </div>
      </div>
      <InboxContent />
    </div>
  </LoadingRegion>
);
