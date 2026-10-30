import type { JSX } from "react";
import { LoadingRegion } from "./loading-skeletons";
import { Skeleton } from "./skeleton";
import { WorkspaceHeader } from "./workspace-layout";
import { ReviewInboxContentSkeleton } from "./review-loading-inbox";
import "./review-workspace.css";

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
      <ReviewInboxContentSkeleton />
    </div>
  </LoadingRegion>
);
